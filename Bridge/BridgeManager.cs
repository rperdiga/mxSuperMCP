using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace MCPExtension.Bridge
{
    /// <summary>
    /// Manages WebSocket connections from the Web Extension bridge.
    /// The C# MCP server hosts a /bridge WebSocket endpoint.
    /// The web extension connects as a client and executes API calls on demand.
    /// </summary>
    public class BridgeManager
    {
        private WebSocket? _webSocket;
        private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonObject>> _pendingRequests = new();
        private CancellationTokenSource? _receiveCts;
        private Task? _receiveTask;
        private readonly Action<string> _log;
        private int _requestCounter;

        public bool IsConnected => _webSocket?.State == WebSocketState.Open;

        public event Action? OnConnected;
        public event Action? OnDisconnected;

        public BridgeManager(Action<string> log)
        {
            _log = log;
        }

        /// <summary>
        /// Accept an incoming WebSocket connection from the web extension.
        /// Replaces any existing connection.
        /// </summary>
        public async Task AcceptConnectionAsync(WebSocket webSocket)
        {
            // Close existing connection if any
            if (_webSocket != null && _webSocket.State == WebSocketState.Open)
            {
                try
                {
                    _receiveCts?.Cancel();
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "New connection", CancellationToken.None);
                }
                catch { }
            }

            _webSocket = webSocket;
            _receiveCts = new CancellationTokenSource();

            // Cancel any pending requests from old connection
            foreach (var pending in _pendingRequests)
            {
                pending.Value.TrySetException(new Exception("Bridge connection replaced"));
            }
            _pendingRequests.Clear();

            _log("Bridge: Web extension connected");
            OnConnected?.Invoke();

            // Start receive loop
            _receiveTask = Task.Run(() => ReceiveLoop(_receiveCts.Token));
        }

        /// <summary>
        /// Send a request to the web extension and await the response.
        /// </summary>
        public async Task<JsonObject> CallAsync(string operation, JsonObject args, int timeoutMs = 30000)
        {
            if (!IsConnected)
            {
                throw new Exception("Web Bridge extension is not connected. Please ensure the MCP Web Bridge pane is open in Studio Pro.");
            }

            var requestId = $"req-{Interlocked.Increment(ref _requestCounter)}";
            var tcs = new TaskCompletionSource<JsonObject>();
            _pendingRequests[requestId] = tcs;

            try
            {
                var request = new JsonObject
                {
                    ["type"] = "bridge_request",
                    ["id"] = requestId,
                    ["operation"] = operation,
                    ["args"] = args
                };

                var json = request.ToJsonString();
                var bytes = Encoding.UTF8.GetBytes(json);
                await _webSocket!.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);

                // Await response with timeout
                using var cts = new CancellationTokenSource(timeoutMs);
                cts.Token.Register(() => tcs.TrySetException(new TimeoutException($"Bridge operation '{operation}' timed out after {timeoutMs}ms")));

                return await tcs.Task;
            }
            finally
            {
                _pendingRequests.TryRemove(requestId, out _);
            }
        }

        private async Task ReceiveLoop(CancellationToken ct)
        {
            var buffer = new byte[1024 * 64]; // 64KB buffer

            try
            {
                while (!ct.IsCancellationRequested && _webSocket?.State == WebSocketState.Open)
                {
                    var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _log("Bridge: Web extension disconnected");
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        // Handle fragmented messages
                        var messageBytes = new List<byte>(buffer.Take(result.Count));
                        while (!result.EndOfMessage)
                        {
                            result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                            messageBytes.AddRange(buffer.Take(result.Count));
                        }

                        var json = Encoding.UTF8.GetString(messageBytes.ToArray());
                        ProcessMessage(json);
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException ex)
            {
                _log($"Bridge: WebSocket error: {ex.Message}");
            }
            finally
            {
                OnDisconnected?.Invoke();

                // Cancel all pending requests
                foreach (var pending in _pendingRequests)
                {
                    pending.Value.TrySetException(new Exception("Bridge connection lost"));
                }
                _pendingRequests.Clear();
            }
        }

        private void ProcessMessage(string json)
        {
            try
            {
                var msg = JsonNode.Parse(json)?.AsObject();
                if (msg == null) return;

                var msgType = msg["type"]?.GetValue<string>();

                // Handle handshake
                if (msgType == "handshake")
                {
                    _log($"Bridge: Handshake received (v{msg["version"]?.GetValue<string>() ?? "?"})");
                    return;
                }

                // Handle response to a pending request
                var id = msg["id"]?.GetValue<string>();
                if (id != null && _pendingRequests.TryGetValue(id, out var tcs))
                {
                    var success = msg["success"]?.GetValue<bool>() ?? false;
                    if (success)
                    {
                        var result = msg["result"]?.AsObject() ?? new JsonObject();
                        tcs.TrySetResult(result);
                    }
                    else
                    {
                        var error = msg["error"]?.GetValue<string>() ?? "Unknown bridge error";
                        tcs.TrySetException(new Exception(error));
                    }
                }
            }
            catch (Exception ex)
            {
                _log($"Bridge: Error processing message: {ex.Message}");
            }
        }

        public async Task DisconnectAsync()
        {
            _receiveCts?.Cancel();

            if (_webSocket?.State == WebSocketState.Open)
            {
                try
                {
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Server shutting down", CancellationToken.None);
                }
                catch { }
            }
        }
    }
}
