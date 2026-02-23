import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { IComponent, getStudioProApi } from "@mendix/extensions-api";

const BridgeComponent = ({ studioPro }: { studioPro: any }) => {
    const [status, setStatus] = useState("Disconnected");
    const [logs, setLogs] = useState<string[]>([]);
    const [port, setPort] = useState(3001);

    const objectCacheRef = useRef<Map<string, any>>(new Map());

    // Queue for serializing domain model operations
    const domainModelQueueRef = useRef<{
        queue: Array<() => Promise<any>>,
        processing: boolean
    }>({ queue: [], processing: false });

    const addLog = (msg: string) => setLogs(prev => [...prev.slice(-29), `[${new Date().toLocaleTimeString()}] ${msg}`]);

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const retryOperation = async <T,>(op: () => Promise<T>, opName: string, maxRetries = 3): Promise<T> => {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await op();
            } catch (err: any) {
                const isRetryable = err.message && (
                    err.message.includes('not found') ||
                    err.message.includes('does not exist')
                );
                if (i === maxRetries - 1 || !isRetryable) throw err;
                const delay = Math.pow(2, i) * 500;
                addLog(`Retry ${i + 1}/${maxRetries} for ${opName} after ${delay}ms...`);
                await sleep(delay);
            }
        }
        throw new Error('Retry logic failed');
    };

    const withDomainModelLock = async <T,>(operation: () => Promise<T>): Promise<T> => {
        const queueState = domainModelQueueRef.current;
        return new Promise((resolve, reject) => {
            const task = async () => {
                try { resolve(await operation()); }
                catch (error) { reject(error); }
            };
            queueState.queue.push(task);
            if (!queueState.processing) {
                queueState.processing = true;
                (async () => {
                    while (queueState.queue.length > 0) {
                        const nextTask = queueState.queue.shift();
                        if (nextTask) await nextTask();
                    }
                    queueState.processing = false;
                })();
            }
        });
    };

    // Helper: find page by name across modules
    const findPageId = async (pageName: string, moduleName?: string): Promise<string> => {
        const modules = await studioPro.app.model.projects.getModules();
        const targetModules = moduleName
            ? modules.filter((m: any) => m.name === moduleName)
            : modules;

        for (const mod of targetModules) {
            const docs = await studioPro.app.model.getDocuments(mod.$ID);
            if (!docs) continue;
            for (const doc of docs) {
                if (doc.$Type === "Pages$Page" && doc.name === pageName) {
                    return doc.$ID;
                }
            }
        }
        throw new Error(`Page '${pageName}' not found${moduleName ? ` in module '${moduleName}'` : ''}`);
    };

    // Helper: find microflow by name across modules
    const findMicroflowId = async (mfName: string, moduleName?: string): Promise<string> => {
        const modules = await studioPro.app.model.projects.getModules();
        const targetModules = moduleName
            ? modules.filter((m: any) => m.name === moduleName)
            : modules;

        for (const mod of targetModules) {
            const docs = await studioPro.app.model.getDocuments(mod.$ID);
            if (!docs) continue;
            for (const doc of docs) {
                if (doc.$Type === "Microflows$Microflow" && doc.name === mfName) {
                    return doc.$ID;
                }
            }
        }
        throw new Error(`Microflow '${mfName}' not found${moduleName ? ` in module '${moduleName}'` : ''}`);
    };

    // Helper: load page by ID
    const loadPage = async (pageId: string): Promise<any> => {
        const pagesResult = await studioPro.app.model.pages.loadUnits("Pages$Page", [pageId]);
        if (!pagesResult || (Array.isArray(pagesResult) && pagesResult.length === 0)) {
            throw new Error(`Page with ID '${pageId}' not found`);
        }
        let page = Array.isArray(pagesResult) ? pagesResult[0] : pagesResult;
        if (page && typeof page.then === 'function') page = await page;
        return page;
    };

    // Helper: find placeholder in page (supports partial name match)
    const findPlaceholder = (page: any, placeholderName: string): any => {
        if (!page?.layoutCall?.arguments) {
            throw new Error("Page has no layout or placeholders");
        }
        let placeholder = page.layoutCall.arguments.find(
            (arg: any) => arg.parameter === placeholderName
        );
        if (!placeholder) {
            placeholder = page.layoutCall.arguments.find(
                (arg: any) => arg.parameter.endsWith(`.${placeholderName}`) || arg.parameter.endsWith(`/${placeholderName}`)
            );
        }
        if (!placeholder) {
            const available = page.layoutCall.arguments.map((a: any) => a.parameter).join(", ");
            throw new Error(`Placeholder '${placeholderName}' not found. Available: ${available}`);
        }
        return placeholder;
    };

    // Helper: recursively find widget by name
    const findWidgetByName = (widgets: any[], name: string): any => {
        for (const w of widgets) {
            if (w.name === name) return w;
            if (w.widgets && Array.isArray(w.widgets)) {
                const found = findWidgetByName(w.widgets, name);
                if (found) return found;
            }
        }
        return null;
    };

    useEffect(() => {
        let ws: WebSocket;
        let reconnectTimer: any;
        const objectCache = objectCacheRef.current;

        const connect = () => {
            const wsUrl = `ws://localhost:${port}/bridge`;
            addLog(`Connecting to ${wsUrl}...`);
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                setStatus("Connected");
                addLog(`Connected to C# MCP bridge`);
                // Send handshake
                ws.send(JSON.stringify({ type: "handshake", version: "1.0" }));
            };

            ws.onclose = () => {
                setStatus("Disconnected");
                addLog("Disconnected - reconnecting in 3s...");
                reconnectTimer = setTimeout(connect, 3000);
            };

            ws.onerror = (err) => {
                console.error("WebSocket error", err);
                ws.close();
            };

            ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type !== "bridge_request") return;

                    const { id, operation, args } = msg;
                    addLog(`REQ: ${operation}`);

                    try {
                        let result: any;

                        // ============================================================
                        // PAGE OPERATIONS
                        // ============================================================

                        if (operation === "create_page") {
                            const { moduleName, pageName, layoutName } = args;
                            addLog(`Creating page '${pageName}' in ${moduleName}`);

                            const modules = await studioPro.app.model.projects.getModules();
                            const mod = modules.find((m: any) => m.name === moduleName);
                            if (!mod) throw new Error(`Module '${moduleName}' not found`);

                            // Find layout
                            const layoutsInfo = await studioPro.app.model.pages.getUnitsInfo("Layouts$Layout");
                            let layout: any = null;
                            if (layoutName) {
                                layout = layoutsInfo.find((l: any) =>
                                    l.name === layoutName ||
                                    l.name.endsWith(`.${layoutName}`) ||
                                    l.qualifiedName === layoutName
                                );
                                if (!layout) {
                                    const available = layoutsInfo.map((l: any) => l.name).join(", ");
                                    throw new Error(`Layout '${layoutName}' not found. Available: ${available}`);
                                }
                            } else if (layoutsInfo.length > 0) {
                                layout = layoutsInfo[0];
                            }

                            const pageOptions: any = { name: pageName };
                            if (layout) pageOptions.layoutId = layout.$ID;

                            const page = await studioPro.app.model.pages.addBlankPage(mod.$ID, pageOptions);
                            addLog(`Page '${pageName}' created!`);

                            result = {
                                success: true,
                                pageId: page?.$ID,
                                pageName,
                                moduleName,
                                layout: layout?.name
                            };
                        }

                        else if (operation === "get_page_structure") {
                            const { pageName, moduleName } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);

                            const pageInfo: any = {
                                $ID: page?.$ID,
                                name: page?.name || "Unknown",
                                title: null,
                                placeholders: [],
                                widgets: []
                            };

                            // Extract title
                            if (page?.title?.translations) {
                                const enUS = page.title.translations.find((t: any) => t.languageCode === "en_US");
                                pageInfo.title = enUS?.text || null;
                            }

                            if (page?.layoutCall) {
                                const layoutCallArgs = page.layoutCall.arguments || [];
                                for (const arg of layoutCallArgs) {
                                    const placeholderInfo: any = {
                                        $ID: arg.$ID,
                                        parameter: arg.parameter,
                                        widgets: []
                                    };
                                    const widgets = arg.widgets || [];
                                    for (const widget of widgets) {
                                        placeholderInfo.widgets.push({
                                            $ID: widget.$ID,
                                            $Type: widget.$Type,
                                            name: widget.name || "unnamed"
                                        });
                                    }
                                    pageInfo.placeholders.push(arg.parameter);
                                    pageInfo.widgets.push(placeholderInfo);
                                }
                            }

                            objectCache.set(pageId, page);
                            result = pageInfo;
                        }

                        else if (operation === "add_widget") {
                            const { pageName, moduleName, placeholderName, widgetType, widgetOptions } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);
                            const placeholder = findPlaceholder(page, placeholderName);

                            const addMethodName = `add${widgetType}`;
                            if (typeof placeholder[addMethodName] !== "function") {
                                const methods = Object.keys(placeholder)
                                    .filter(k => typeof placeholder[k] === 'function' && k.startsWith('add'));
                                throw new Error(`Widget type '${widgetType}' not supported. Available: ${methods.join(', ')}`);
                            }

                            const widget = await placeholder[addMethodName](widgetOptions || {});

                            // Set caption if provided
                            if (widgetOptions?.caption && widget?.caption) {
                                try {
                                    if (typeof widget.caption.addTranslation === 'function') {
                                        await widget.caption.addTranslation({ languageCode: "en_US", text: widgetOptions.caption });
                                    }
                                } catch (e: any) {
                                    addLog(`Warning: Could not set caption: ${e.message}`);
                                }
                            }

                            // For Title widgets, also set page title
                            if (widgetType === 'Title' && widgetOptions?.caption && page?.title) {
                                try {
                                    if (typeof page.title.addTranslation === 'function') {
                                        await page.title.addTranslation({ languageCode: "en_US", text: widgetOptions.caption });
                                    }
                                } catch (e: any) {
                                    addLog(`Warning: Could not set page title: ${e.message}`);
                                }
                            }

                            await studioPro.app.model.pages.save(page);
                            addLog(`${widgetType} added and saved!`);

                            result = {
                                success: true,
                                widgetId: widget.$ID,
                                widgetType: widget.$Type,
                                name: widget.name
                            };
                        }

                        else if (operation === "add_widget_to_container") {
                            const { pageName, moduleName, placeholderName, containerName, widgetType, widgetOptions } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);
                            const placeholder = findPlaceholder(page, placeholderName);

                            const container = findWidgetByName(placeholder.widgets || [], containerName);
                            if (!container) {
                                const topLevel = (placeholder.widgets || []).map((w: any) => w.name).join(", ");
                                throw new Error(`Container '${containerName}' not found. Top-level: ${topLevel}`);
                            }

                            const addMethodName = `add${widgetType}`;
                            if (typeof container[addMethodName] !== "function") {
                                const methods = Object.keys(container)
                                    .filter(k => typeof container[k] === 'function' && k.startsWith('add'));
                                throw new Error(`Widget type '${widgetType}' not supported on container. Available: ${methods.join(', ')}`);
                            }

                            const widget = await container[addMethodName](widgetOptions || {});

                            if (widgetOptions?.caption && widget?.caption) {
                                try {
                                    if (typeof widget.caption.addTranslation === 'function') {
                                        await widget.caption.addTranslation({ languageCode: "en_US", text: widgetOptions.caption });
                                    }
                                } catch (e: any) {
                                    addLog(`Warning: Could not set caption: ${e.message}`);
                                }
                            }

                            await studioPro.app.model.pages.save(page);
                            addLog(`${widgetType} added to container '${containerName}' and saved!`);

                            result = {
                                success: true,
                                widgetId: widget.$ID,
                                widgetType: widget.$Type,
                                name: widget.name,
                                container: containerName
                            };
                        }

                        else if (operation === "delete_widget") {
                            const { pageName, moduleName, placeholderName, widgetName } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);
                            const placeholder = findPlaceholder(page, placeholderName);

                            const widget = (placeholder.widgets || []).find((w: any) => w.name === widgetName);
                            if (!widget) throw new Error(`Widget '${widgetName}' not found in placeholder`);

                            if (typeof widget.delete !== "function") throw new Error("Widget does not support deletion");
                            widget.delete();

                            await studioPro.app.model.pages.save(page);
                            addLog(`Widget '${widgetName}' deleted!`);
                            result = { success: true, deletedWidget: widgetName };
                        }

                        else if (operation === "set_page_title") {
                            const { pageName, moduleName, title } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);

                            if (page?.title) {
                                // Remove existing en_US to prevent duplicates
                                if (Array.isArray(page.title.translations)) {
                                    const existing = page.title.translations.filter((t: any) => t.languageCode === "en_US");
                                    for (const t of existing) {
                                        if (typeof t.delete === 'function') t.delete();
                                    }
                                }
                                if (typeof page.title.addTranslation === 'function') {
                                    await page.title.addTranslation({ languageCode: "en_US", text: title });
                                }
                            }

                            await studioPro.app.model.pages.save(page);
                            addLog(`Page title set to '${title}'`);
                            result = { success: true, title };
                        }

                        else if (operation === "list_layouts") {
                            const layoutsInfo = await studioPro.app.model.pages.getUnitsInfo("Layouts$Layout");
                            result = {
                                success: true,
                                count: layoutsInfo.length,
                                layouts: layoutsInfo.map((l: any) => ({
                                    $ID: l.$ID,
                                    name: l.name,
                                    qualifiedName: l.qualifiedName
                                }))
                            };
                        }

                        // ============================================================
                        // ENHANCED MICROFLOW OPERATIONS (ByNameReference support)
                        // ============================================================

                        else if (operation === "web_create_object_action") {
                            const { microflowName, moduleName, entityName, outputVariable, memberChanges, commitType } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const newActivity = await studioPro.app.model.microflows.createElement("Microflows$ActionActivity");
                            newActivity.action = await studioPro.app.model.microflows.createElement("Microflows$CreateObjectAction");
                            newActivity.action.entity = entityName; // ByNameReference!

                            if (outputVariable) {
                                newActivity.action.outputVariableName = outputVariable;
                            }

                            if (commitType) {
                                newActivity.action.commit = commitType; // "Yes", "YesWithoutEvents", "No"
                            }

                            // Add member changes (attribute assignments)
                            if (memberChanges && Array.isArray(memberChanges)) {
                                for (const mc of memberChanges) {
                                    const memberChange = await studioPro.app.model.microflows.createElement("Microflows$MemberChange");
                                    memberChange.attribute = mc.attribute; // e.g., "Module.Entity.AttrName"
                                    memberChange.value = mc.value; // Mendix expression
                                    newActivity.action.items.push(memberChange);
                                    addLog(`  Member change: ${mc.attribute} = ${mc.value}`);
                                }
                            }

                            objectCollection.objects.push(newActivity);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`CreateObject action added for ${entityName}`);

                            result = {
                                success: true,
                                activityId: newActivity.$ID,
                                entity: entityName,
                                outputVariable,
                                memberChangeCount: memberChanges?.length || 0
                            };
                        }

                        else if (operation === "web_change_object_action") {
                            const { microflowName, moduleName, inputVariable, memberChanges, commitType, refreshInClient } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const newActivity = await studioPro.app.model.microflows.createElement("Microflows$ActionActivity");
                            newActivity.action = await studioPro.app.model.microflows.createElement("Microflows$ChangeObjectAction");

                            if (inputVariable) {
                                newActivity.action.changeVariableName = inputVariable;
                            }
                            if (commitType) {
                                newActivity.action.commit = commitType;
                            }
                            if (refreshInClient !== undefined) {
                                newActivity.action.refreshInClient = refreshInClient;
                            }

                            if (memberChanges && Array.isArray(memberChanges)) {
                                for (const mc of memberChanges) {
                                    const memberChange = await studioPro.app.model.microflows.createElement("Microflows$MemberChange");
                                    memberChange.attribute = mc.attribute;
                                    memberChange.value = mc.value;
                                    newActivity.action.items.push(memberChange);
                                }
                            }

                            objectCollection.objects.push(newActivity);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`ChangeObject action added for ${inputVariable}`);

                            result = {
                                success: true,
                                activityId: newActivity.$ID,
                                inputVariable,
                                memberChangeCount: memberChanges?.length || 0
                            };
                        }

                        else if (operation === "web_retrieve_action") {
                            const { microflowName, moduleName, entityName, outputVariable, xpathConstraint, rangeType, rangeAmount } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const newActivity = await studioPro.app.model.microflows.createElement("Microflows$ActionActivity");
                            newActivity.action = await studioPro.app.model.microflows.createElement("Microflows$RetrieveAction");
                            newActivity.action.retrieveSource = await studioPro.app.model.microflows.createElement("Microflows$DatabaseRetrieveSource");
                            newActivity.action.retrieveSource.entity = entityName; // ByNameReference!

                            if (outputVariable) {
                                newActivity.action.outputVariableName = outputVariable;
                            }

                            if (xpathConstraint) {
                                newActivity.action.retrieveSource.xPathConstraint = xpathConstraint;
                            }

                            if (rangeType === "first" || rangeType === "custom") {
                                const constantRange = await studioPro.app.model.microflows.createElement("Microflows$ConstantRange");
                                if (rangeType === "first") {
                                    constantRange.singleObject = true;
                                }
                                if (rangeAmount) {
                                    constantRange.amount = rangeAmount.toString();
                                }
                                newActivity.action.retrieveSource.range = constantRange;
                            }

                            objectCollection.objects.push(newActivity);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`Retrieve action added for ${entityName}`);

                            result = {
                                success: true,
                                activityId: newActivity.$ID,
                                entity: entityName,
                                outputVariable,
                                xpathConstraint: xpathConstraint || null
                            };
                        }

                        // ============================================================
                        // EDITOR OPERATIONS
                        // ============================================================

                        else if (operation === "open_document") {
                            const { documentName, moduleName, documentType } = args;
                            const modules = await studioPro.app.model.projects.getModules();
                            const targetModules = moduleName
                                ? modules.filter((m: any) => m.name === moduleName)
                                : modules;

                            let docId: string | null = null;
                            for (const mod of targetModules) {
                                const docs = await studioPro.app.model.getDocuments(mod.$ID);
                                if (!docs) continue;
                                for (const doc of docs) {
                                    if (doc.name === documentName) {
                                        if (!documentType || doc.$Type.includes(documentType)) {
                                            docId = doc.$ID;
                                            break;
                                        }
                                    }
                                }
                                if (docId) break;
                            }

                            if (!docId) throw new Error(`Document '${documentName}' not found`);

                            await studioPro.app.model.openDocument(docId);
                            addLog(`Opened document '${documentName}'`);
                            result = { success: true, documentName, documentId: docId };
                        }

                        else if (operation === "get_active_document") {
                            // This may not be available in all API versions
                            try {
                                const activeDoc = await studioPro.app.model.getActiveDocument?.();
                                result = {
                                    success: true,
                                    document: activeDoc ? {
                                        $ID: activeDoc.$ID,
                                        $Type: activeDoc.$Type,
                                        name: activeDoc.name
                                    } : null
                                };
                            } catch (e: any) {
                                result = { success: false, error: "get_active_document not available in this API version" };
                            }
                        }

                        // ============================================================
                        // PING (for health checks)
                        // ============================================================

                        else if (operation === "ping") {
                            result = { success: true, pong: true, timestamp: Date.now() };
                        }

                        else {
                            throw new Error(`Unknown operation: ${operation}`);
                        }

                        // Send success response
                        ws.send(JSON.stringify({ id, success: true, result }));
                        addLog(`OK: ${operation}`);

                    } catch (err: any) {
                        console.error(err);
                        ws.send(JSON.stringify({ id, success: false, error: err.message }));
                        addLog(`ERR: ${operation} - ${err.message}`);
                    }
                } catch (e) {
                    console.error("Error handling message", e);
                }
            };
        };

        connect();

        return () => {
            if (ws) ws.close();
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };
    }, [studioPro, port]);

    return (
        <div style={{ padding: 10, fontFamily: "system-ui", fontSize: 12 }}>
            <h3 style={{ margin: "0 0 8px 0" }}>MCP Web Bridge</h3>
            <div style={{ marginBottom: 8 }}>
                Status: <span style={{
                    color: status === "Connected" ? "#0a0" : "#c00",
                    fontWeight: "bold"
                }}>{status}</span>
            </div>
            <div style={{ marginBottom: 8 }}>
                <label>
                    C# Server Port:{" "}
                    <input
                        type="number"
                        value={port}
                        onChange={(e) => setPort(parseInt(e.target.value) || 3001)}
                        style={{ width: 60 }}
                    />
                </label>
            </div>
            <div style={{
                background: "#f5f5f5",
                padding: 8,
                height: 250,
                overflow: "auto",
                fontSize: 11,
                border: "1px solid #ddd",
                borderRadius: 4,
                fontFamily: "monospace"
            }}>
                {logs.length === 0 && <div style={{ color: "#999" }}>Waiting for connection...</div>}
                {logs.map((l, i) => (
                    <div key={i} style={{ marginBottom: 2, borderBottom: "1px solid #eee", paddingBottom: 1 }}>
                        {l}
                    </div>
                ))}
            </div>
        </div>
    );
};

export const component: IComponent = {
    async loaded(componentContext) {
        const studioPro = getStudioProApi(componentContext);
        createRoot(document.getElementById("root")!).render(
            <BridgeComponent studioPro={studioPro} />
        );
    }
};
