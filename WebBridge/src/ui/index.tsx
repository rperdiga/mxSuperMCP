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

    // Helper: find a unit by name using getUnitsInfo (replaces broken getDocuments API)
    const findUnitId = async (
        subsystem: any,
        unitType: string,
        unitName: string,
        moduleName?: string,
        label?: string
    ): Promise<string> => {
        const units = await subsystem.getUnitsInfo(unitType);
        if (!units || units.length === 0) {
            throw new Error(`${label || unitType} '${unitName}' not found — no units of that type exist`);
        }
        for (const u of units) {
            const nameMatch = u.name === unitName;
            const qualMatch = u.qualifiedName === `${moduleName}.${unitName}`;
            if (nameMatch || qualMatch) {
                if (!moduleName) return u.$ID;
                // Check module by qualifiedName prefix
                if (u.qualifiedName && u.qualifiedName.startsWith(`${moduleName}.`)) return u.$ID;
                // If no qualifiedName, accept name match
                if (!u.qualifiedName) return u.$ID;
            }
        }
        const available = units.map((u: any) => u.qualifiedName || u.name).join(", ");
        throw new Error(`${label || unitType} '${unitName}' not found${moduleName ? ` in module '${moduleName}'` : ''}. Available: ${available}`);
    };

    // Helper: find page by name across modules
    const findPageId = async (pageName: string, moduleName?: string): Promise<string> => {
        return findUnitId(studioPro.app.model.pages, "Pages$Page", pageName, moduleName, "Page");
    };

    // Helper: find microflow by name across modules
    const findMicroflowId = async (mfName: string, moduleName?: string): Promise<string> => {
        return findUnitId(studioPro.app.model.microflows, "Microflows$Microflow", mfName, moduleName, "Microflow");
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

    // Helper: find workflow by name across modules
    const findWorkflowId = async (workflowName: string, moduleName?: string): Promise<string> => {
        return findUnitId(studioPro.app.model.workflows, "Workflows$Workflow", workflowName, moduleName, "Workflow");
    };

    // Helper: load workflow by ID
    const loadWorkflow = async (workflowId: string): Promise<any> => {
        const result = await studioPro.app.model.workflows.loadUnits("Workflows$Workflow", [workflowId]);
        if (!result || (Array.isArray(result) && result.length === 0)) {
            throw new Error(`Workflow with ID '${workflowId}' not found`);
        }
        let workflow = Array.isArray(result) ? result[0] : result;
        if (workflow && typeof workflow.then === 'function') workflow = await workflow;
        return workflow;
    };

    // Helper: find snippet by name across modules
    const findSnippetId = async (snippetName: string, moduleName?: string): Promise<string> => {
        return findUnitId(studioPro.app.model.snippets, "Pages$Snippet", snippetName, moduleName, "Snippet");
    };

    // Helper: find building block by name across modules
    const findBuildingBlockId = async (blockName: string, moduleName?: string): Promise<string> => {
        return findUnitId(studioPro.app.model.buildingBlocks, "Pages$BuildingBlock", blockName, moduleName, "Building block");
    };

    // Helper: find enumeration by name across modules
    const findEnumerationId = async (enumName: string, moduleName?: string): Promise<string> => {
        return findUnitId(studioPro.app.model.enumerations, "Enumerations$Enumeration", enumName, moduleName, "Enumeration");
    };

    // Helper: get domain model for a module
    const getDomainModelForModule = async (moduleName: string): Promise<any> => {
        // Domain model loading/modification is NOT supported by the Web Extension API's domainModels subsystem.
        // The domainModels subsystem only supports getUnitsInfo (read metadata), not loadUnits/createElement/save.
        // Security/validation tools that need domain model access should be routed through C# native tools instead.
        throw new Error(
            `Domain model modification is not supported from the Web Extension API. ` +
            `The tools web_add_access_rule, web_set_member_access, and web_add_validation_rule ` +
            `require native C# implementation. Use the C# read_entity_access_rules tool to read existing rules.`
        );
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
                        // ADVANCED MICROFLOW OPERATIONS (Group A)
                        // ============================================================

                        else if (operation === "web_log_message_action") {
                            const { microflowName, moduleName, level, node, messageTemplate, includeStackTrace } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const newActivity = await studioPro.app.model.microflows.createElement("Microflows$ActionActivity");
                            newActivity.action = await studioPro.app.model.microflows.createElement("Microflows$LogMessageAction");

                            if (level) newActivity.action.level = level; // Info, Warning, Error, Debug, Trace, Critical
                            if (node) newActivity.action.node = node;
                            if (messageTemplate) {
                                newActivity.action.messageTemplate = await studioPro.app.model.microflows.createElement("Microflows$StringTemplate");
                                newActivity.action.messageTemplate.text = messageTemplate;
                            }
                            if (includeStackTrace !== undefined) {
                                newActivity.action.includeLatestStackTrace = includeStackTrace;
                            }

                            objectCollection.objects.push(newActivity);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`LogMessage action added (level: ${level || 'Info'})`);

                            result = {
                                success: true,
                                activityId: newActivity.$ID,
                                level: level || "Info",
                                node: node || ""
                            };
                        }

                        else if (operation === "web_exclusive_split") {
                            const { microflowName, moduleName, caption, expression, trueCaseCaption, falseCaseCaption } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const split = await studioPro.app.model.microflows.createElement("Microflows$ExclusiveSplit");
                            if (caption) split.caption = caption;

                            // Set split condition with expression
                            const splitCondition = await studioPro.app.model.microflows.createElement("Microflows$ExpressionSplitCondition");
                            if (expression) splitCondition.expression = expression;
                            split.splitCondition = splitCondition;

                            objectCollection.objects.push(split);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`ExclusiveSplit added: ${caption || 'Decision'}`);

                            result = {
                                success: true,
                                splitId: split.$ID,
                                caption: caption || "",
                                expression: expression || "",
                                trueCaseCaption: trueCaseCaption || "true",
                                falseCaseCaption: falseCaseCaption || "false"
                            };
                        }

                        else if (operation === "web_delete_object_action") {
                            const { microflowName, moduleName, inputVariable, refreshInClient } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const newActivity = await studioPro.app.model.microflows.createElement("Microflows$ActionActivity");
                            newActivity.action = await studioPro.app.model.microflows.createElement("Microflows$DeleteAction");

                            if (inputVariable) newActivity.action.deleteVariableName = inputVariable;
                            if (refreshInClient !== undefined) newActivity.action.refreshInClient = refreshInClient;

                            objectCollection.objects.push(newActivity);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`DeleteObject action added for ${inputVariable}`);

                            result = {
                                success: true,
                                activityId: newActivity.$ID,
                                inputVariable
                            };
                        }

                        else if (operation === "web_commit_action") {
                            const { microflowName, moduleName, inputVariable, withEvents, refreshInClient } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const newActivity = await studioPro.app.model.microflows.createElement("Microflows$ActionActivity");
                            newActivity.action = await studioPro.app.model.microflows.createElement("Microflows$CommitAction");

                            if (inputVariable) newActivity.action.commitVariableName = inputVariable;
                            if (withEvents !== undefined) newActivity.action.withEvents = withEvents;
                            if (refreshInClient !== undefined) newActivity.action.refreshInClient = refreshInClient;

                            objectCollection.objects.push(newActivity);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`Commit action added for ${inputVariable}`);

                            result = {
                                success: true,
                                activityId: newActivity.$ID,
                                inputVariable,
                                withEvents: withEvents !== undefined ? withEvents : true
                            };
                        }

                        else if (operation === "web_set_end_event") {
                            const { microflowName, moduleName, returnExpression } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            // Find the EndEvent in the objectCollection
                            let endEvent: any = null;
                            for (const obj of objectCollection.objects) {
                                if (obj.$Type === "Microflows$EndEvent") {
                                    endEvent = obj;
                                    break;
                                }
                            }
                            if (!endEvent) throw new Error("No EndEvent found in microflow");

                            endEvent.returnValue = returnExpression;

                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`EndEvent return expression set to: ${returnExpression}`);

                            result = {
                                success: true,
                                endEventId: endEvent.$ID,
                                returnExpression
                            };
                        }

                        else if (operation === "web_microflow_call_action") {
                            const { microflowName, moduleName, calledMicroflow, outputVariable, parameters } = args;
                            const mfId = args.microflowId || await findMicroflowId(microflowName, moduleName);

                            const microflowsResult = await studioPro.app.model.microflows.loadUnits("Microflows$Microflow", [mfId]);
                            let microflow = Array.isArray(microflowsResult) ? microflowsResult[0] : microflowsResult;
                            if (microflow && typeof microflow.then === 'function') microflow = await microflow;

                            const objectCollection = microflow?.objectCollection;
                            if (!objectCollection) throw new Error("Microflow has no objectCollection");

                            const newActivity = await studioPro.app.model.microflows.createElement("Microflows$ActionActivity");
                            newActivity.action = await studioPro.app.model.microflows.createElement("Microflows$MicroflowCallAction");
                            newActivity.action.microflowCall = await studioPro.app.model.microflows.createElement("Microflows$MicroflowCall");
                            newActivity.action.microflowCall.microflow = calledMicroflow; // ByNameReference e.g. "Module.MicroflowName"

                            if (outputVariable) {
                                newActivity.action.outputVariableName = outputVariable;
                            }

                            // Add parameters
                            if (parameters && Array.isArray(parameters)) {
                                for (const param of parameters) {
                                    const paramMapping = await studioPro.app.model.microflows.createElement("Microflows$MicroflowCallParameterMapping");
                                    paramMapping.parameter = param.name; // ByNameReference
                                    paramMapping.argument = param.value; // Expression
                                    newActivity.action.microflowCall.parameterMappings.push(paramMapping);
                                    addLog(`  Param: ${param.name} = ${param.value}`);
                                }
                            }

                            objectCollection.objects.push(newActivity);
                            await studioPro.app.model.microflows.save(microflow);
                            addLog(`MicroflowCall action added: ${calledMicroflow}`);

                            result = {
                                success: true,
                                activityId: newActivity.$ID,
                                calledMicroflow,
                                outputVariable,
                                parameterCount: parameters?.length || 0
                            };
                        }

                        // ============================================================
                        // WORKFLOW OPERATIONS (Group B)
                        // ============================================================

                        else if (operation === "web_create_workflow") {
                            const { moduleName, workflowName, contextEntity, title } = args;

                            const modules = await studioPro.app.model.projects.getModules();
                            const mod = modules.find((m: any) => m.name === moduleName);
                            if (!mod) throw new Error(`Module '${moduleName}' not found`);

                            const workflowOptions: any = { name: workflowName };
                            if (contextEntity) workflowOptions.contextEntity = contextEntity;

                            const workflow = await studioPro.app.model.workflows.addWorkflow(mod.$ID, workflowOptions);

                            if (title && workflow?.title) {
                                if (typeof workflow.title.addTranslation === 'function') {
                                    await workflow.title.addTranslation({ languageCode: "en_US", text: title });
                                }
                            }

                            await studioPro.app.model.workflows.save(workflow);
                            addLog(`Workflow '${workflowName}' created in ${moduleName}`);

                            result = {
                                success: true,
                                workflowId: workflow?.$ID,
                                workflowName,
                                moduleName,
                                contextEntity: contextEntity || null
                            };
                        }

                        else if (operation === "web_add_user_task") {
                            const { workflowName, moduleName, taskName, caption, taskPage, outcomes } = args;
                            const wfId = await findWorkflowId(workflowName, moduleName);
                            const workflow = await loadWorkflow(wfId);

                            const userTask = await studioPro.app.model.workflows.createElement("Workflows$SingleUserTaskActivity");
                            if (taskName) userTask.name = taskName;
                            if (caption && userTask.caption) {
                                if (typeof userTask.caption.addTranslation === 'function') {
                                    await userTask.caption.addTranslation({ languageCode: "en_US", text: caption });
                                }
                            }
                            if (taskPage) userTask.taskPage = taskPage; // ByNameReference

                            // Add outcomes
                            if (outcomes && Array.isArray(outcomes)) {
                                for (const outcome of outcomes) {
                                    const userTaskOutcome = await studioPro.app.model.workflows.createElement("Workflows$UserTaskOutcome");
                                    if (outcome.name) userTaskOutcome.name = outcome.name;
                                    if (outcome.caption && userTaskOutcome.caption) {
                                        if (typeof userTaskOutcome.caption.addTranslation === 'function') {
                                            await userTaskOutcome.caption.addTranslation({ languageCode: "en_US", text: outcome.caption });
                                        }
                                    }
                                    userTask.outcomes.push(userTaskOutcome);
                                }
                            }

                            workflow.flow.activities.push(userTask);
                            await studioPro.app.model.workflows.save(workflow);
                            addLog(`UserTask '${taskName}' added to workflow '${workflowName}'`);

                            result = {
                                success: true,
                                taskId: userTask.$ID,
                                taskName,
                                outcomeCount: outcomes?.length || 0
                            };
                        }

                        else if (operation === "web_add_workflow_decision") {
                            const { workflowName, moduleName, decisionName, caption, expression, outcomes } = args;
                            const wfId = await findWorkflowId(workflowName, moduleName);
                            const workflow = await loadWorkflow(wfId);

                            const decision = await studioPro.app.model.workflows.createElement("Workflows$ExclusiveSplitActivity");
                            if (decisionName) decision.name = decisionName;
                            if (caption && decision.caption) {
                                if (typeof decision.caption.addTranslation === 'function') {
                                    await decision.caption.addTranslation({ languageCode: "en_US", text: caption });
                                }
                            }
                            if (expression) decision.expression = expression;

                            // Add outcomes
                            if (outcomes && Array.isArray(outcomes)) {
                                for (const outcome of outcomes) {
                                    const splitOutcome = await studioPro.app.model.workflows.createElement("Workflows$ExclusiveSplitOutcome");
                                    if (outcome.name) splitOutcome.name = outcome.name;
                                    if (outcome.caption && splitOutcome.caption) {
                                        if (typeof splitOutcome.caption.addTranslation === 'function') {
                                            await splitOutcome.caption.addTranslation({ languageCode: "en_US", text: outcome.caption });
                                        }
                                    }
                                    if (outcome.value !== undefined) splitOutcome.value = outcome.value;
                                    decision.outcomes.push(splitOutcome);
                                }
                            }

                            workflow.flow.activities.push(decision);
                            await studioPro.app.model.workflows.save(workflow);
                            addLog(`WorkflowDecision '${decisionName}' added to workflow '${workflowName}'`);

                            result = {
                                success: true,
                                decisionId: decision.$ID,
                                decisionName,
                                outcomeCount: outcomes?.length || 0
                            };
                        }

                        else if (operation === "web_add_workflow_call_microflow") {
                            const { workflowName, moduleName, taskName, microflow } = args;
                            const wfId = await findWorkflowId(workflowName, moduleName);
                            const workflow = await loadWorkflow(wfId);

                            const callMf = await studioPro.app.model.workflows.createElement("Workflows$CallMicroflowTask");
                            if (taskName) callMf.name = taskName;
                            if (microflow) callMf.microflow = microflow; // ByNameReference

                            workflow.flow.activities.push(callMf);
                            await studioPro.app.model.workflows.save(workflow);
                            addLog(`CallMicroflow '${taskName}' added to workflow '${workflowName}'`);

                            result = {
                                success: true,
                                taskId: callMf.$ID,
                                taskName,
                                microflow
                            };
                        }

                        else if (operation === "web_add_workflow_parallel_split") {
                            const { workflowName, moduleName, splitName, pathCount } = args;
                            const wfId = await findWorkflowId(workflowName, moduleName);
                            const workflow = await loadWorkflow(wfId);

                            const parallelSplit = await studioPro.app.model.workflows.createElement("Workflows$ParallelSplitActivity");
                            if (splitName) parallelSplit.name = splitName;

                            // Add paths
                            const count = pathCount || 2;
                            for (let i = 0; i < count; i++) {
                                const path = await studioPro.app.model.workflows.createElement("Workflows$ParallelSplitOutcome");
                                path.name = `Path${i + 1}`;
                                parallelSplit.outcomes.push(path);
                            }

                            workflow.flow.activities.push(parallelSplit);
                            await studioPro.app.model.workflows.save(workflow);
                            addLog(`ParallelSplit '${splitName}' added to workflow '${workflowName}' (${count} paths)`);

                            result = {
                                success: true,
                                splitId: parallelSplit.$ID,
                                splitName,
                                pathCount: count
                            };
                        }

                        // ============================================================
                        // SECURITY & ENUMERATION OPERATIONS (Group C)
                        // ============================================================

                        else if (operation === "web_add_access_rule") {
                            const { moduleName, entityName, moduleRoles, allowCreate, allowDelete, defaultRights, xpathConstraint } = args;
                            let domainModel: any;
                            try {
                                domainModel = await getDomainModelForModule(moduleName);
                            } catch (dmErr: any) {
                                throw new Error(`[getDomainModel] ${dmErr.message}`);
                            }

                            // Find entity in domain model
                            const entity = domainModel.entities.find((e: any) => e.name === entityName);
                            if (!entity) {
                                const available = domainModel.entities?.map((e: any) => e.name).join(', ') || 'none';
                                throw new Error(`Entity '${entityName}' not found in module '${moduleName}'. Available: ${available}`);
                            }

                            // Discover entity properties for access rules
                            const entityKeys = Object.keys(entity);
                            const accessRulesProp = entity.accessRules || entity.accessRulesList || entity.access;

                            const dmApi = studioPro.app.model.domainModels;
                            const createFn = typeof dmApi.createElement === 'function' ? dmApi.createElement :
                                             (dmApi.modelComponent && typeof dmApi.modelComponent.createElement === 'function') ? dmApi.modelComponent.createElement.bind(dmApi.modelComponent) : null;
                            const saveFn = typeof dmApi.save === 'function' ? dmApi.save :
                                           (dmApi.modelComponent && typeof dmApi.modelComponent.save === 'function') ? dmApi.modelComponent.save.bind(dmApi.modelComponent) : null;

                            if (!createFn) {
                                throw new Error(`createElement not available on domainModels. Entity keys: [${entityKeys.join(',')}]. Has accessRules: ${!!entity.accessRules}`);
                            }

                            const accessRule = await createFn("DomainModels$AccessRule");
                            if (allowCreate !== undefined) accessRule.allowCreate = allowCreate;
                            if (allowDelete !== undefined) accessRule.allowDelete = allowDelete;
                            if (defaultRights) accessRule.defaultMemberAccessRights = defaultRights;
                            if (xpathConstraint) accessRule.xPathConstraint = xpathConstraint;

                            // Add module roles
                            if (moduleRoles && Array.isArray(moduleRoles)) {
                                for (const roleName of moduleRoles) {
                                    if (accessRule.moduleRoles && typeof accessRule.moduleRoles.push === 'function') {
                                        accessRule.moduleRoles.push(roleName);
                                    }
                                }
                            }

                            if (!accessRulesProp || typeof accessRulesProp.push !== 'function') {
                                throw new Error(`Entity '${entityName}' has no pushable accessRules. Entity keys: [${entityKeys.join(',')}]`);
                            }

                            accessRulesProp.push(accessRule);
                            if (saveFn) await saveFn(domainModel);
                            addLog(`Access rule added to '${entityName}' for roles: ${moduleRoles?.join(', ')}`);

                            result = {
                                success: true,
                                entityName,
                                ruleId: accessRule.$ID,
                                roleCount: moduleRoles?.length || 0
                            };
                        }

                        else if (operation === "web_set_member_access") {
                            const { moduleName, entityName, ruleIndex, memberAccesses } = args;
                            const domainModel = await getDomainModelForModule(moduleName);

                            const entity = domainModel.entities.find((e: any) => e.name === entityName);
                            if (!entity) throw new Error(`Entity '${entityName}' not found in module '${moduleName}'`);

                            const idx = ruleIndex || 0;
                            if (!entity.accessRules || idx >= entity.accessRules.length) {
                                throw new Error(`Access rule at index ${idx} not found. Entity has ${entity.accessRules?.length || 0} rules.`);
                            }
                            const rule = entity.accessRules[idx];

                            if (memberAccesses && Array.isArray(memberAccesses)) {
                                for (const ma of memberAccesses) {
                                    const memberAccess = await studioPro.app.model.domainModels.createElement("DomainModels$MemberAccess");
                                    memberAccess.attribute = ma.attribute; // ByNameReference
                                    memberAccess.accessRights = ma.rights; // ReadWrite, ReadOnly, None
                                    rule.memberAccesses.push(memberAccess);
                                    addLog(`  Member access: ${ma.attribute} = ${ma.rights}`);
                                }
                            }

                            await studioPro.app.model.domainModels.save(domainModel);
                            addLog(`Member access set on '${entityName}' rule #${idx}`);

                            result = {
                                success: true,
                                entityName,
                                ruleIndex: idx,
                                memberAccessCount: memberAccesses?.length || 0
                            };
                        }

                        else if (operation === "web_add_validation_rule") {
                            const { moduleName, entityName, attributeName, ruleType, errorMessage, minValue, maxValue, regexPattern, minLength, maxLength } = args;
                            const domainModel = await getDomainModelForModule(moduleName);

                            const entity = domainModel.entities.find((e: any) => e.name === entityName);
                            if (!entity) throw new Error(`Entity '${entityName}' not found in module '${moduleName}'`);

                            const validationRule = await studioPro.app.model.domainModels.createElement("DomainModels$ValidationRule");
                            if (attributeName) validationRule.attribute = attributeName; // ByNameReference
                            if (ruleType) validationRule.ruleType = ruleType; // Required, Unique, Range, RegularExpression, MaxLength, etc.

                            if (errorMessage && validationRule.errorMessage) {
                                if (typeof validationRule.errorMessage.addTranslation === 'function') {
                                    await validationRule.errorMessage.addTranslation({ languageCode: "en_US", text: errorMessage });
                                }
                            }

                            // Rule-specific params
                            if (minValue !== undefined) validationRule.minValue = minValue.toString();
                            if (maxValue !== undefined) validationRule.maxValue = maxValue.toString();
                            if (regexPattern) validationRule.regExPattern = regexPattern;
                            if (minLength !== undefined) validationRule.minLength = minLength;
                            if (maxLength !== undefined) validationRule.maxLength = maxLength;

                            entity.validationRules.push(validationRule);
                            await studioPro.app.model.domainModels.save(domainModel);
                            addLog(`Validation rule '${ruleType}' added to '${entityName}.${attributeName}'`);

                            result = {
                                success: true,
                                entityName,
                                attributeName,
                                ruleType,
                                ruleId: validationRule.$ID
                            };
                        }

                        else if (operation === "web_create_enumeration") {
                            const { moduleName, enumerationName, values } = args;

                            const modules = await studioPro.app.model.projects.getModules();
                            const mod = modules.find((m: any) => m.name === moduleName);
                            if (!mod) throw new Error(`Module '${moduleName}' not found`);

                            const enumOptions: any = { name: enumerationName };
                            const enumeration = await studioPro.app.model.enumerations.addEnumeration(mod.$ID, enumOptions);

                            // Add values
                            if (values && Array.isArray(values)) {
                                for (const val of values) {
                                    const valueName = typeof val === 'string' ? val : val.name;
                                    const valueCaption = typeof val === 'string' ? val : (val.caption || val.name);
                                    const enumValue = await studioPro.app.model.enumerations.createElement("Enumerations$EnumerationValue");
                                    enumValue.name = valueName;
                                    if (enumValue.caption && typeof enumValue.caption.addTranslation === 'function') {
                                        await enumValue.caption.addTranslation({ languageCode: "en_US", text: valueCaption });
                                    }
                                    enumeration.values.push(enumValue);
                                }
                            }

                            await studioPro.app.model.enumerations.save(enumeration);
                            addLog(`Enumeration '${enumerationName}' created with ${values?.length || 0} values`);

                            result = {
                                success: true,
                                enumerationId: enumeration?.$ID,
                                enumerationName,
                                moduleName,
                                valueCount: values?.length || 0
                            };
                        }

                        else if (operation === "web_add_enumeration_value") {
                            const { moduleName, enumerationName, valueName, caption } = args;
                            const enumId = await findEnumerationId(enumerationName, moduleName);

                            const enumsResult = await studioPro.app.model.enumerations.loadUnits("Enumerations$Enumeration", [enumId]);
                            let enumeration = Array.isArray(enumsResult) ? enumsResult[0] : enumsResult;
                            if (enumeration && typeof enumeration.then === 'function') enumeration = await enumeration;

                            const enumValue = await studioPro.app.model.enumerations.createElement("Enumerations$EnumerationValue");
                            enumValue.name = valueName;
                            if (caption && enumValue.caption && typeof enumValue.caption.addTranslation === 'function') {
                                await enumValue.caption.addTranslation({ languageCode: "en_US", text: caption });
                            }

                            enumeration.values.push(enumValue);
                            await studioPro.app.model.enumerations.save(enumeration);
                            addLog(`Enumeration value '${valueName}' added to '${enumerationName}'`);

                            result = {
                                success: true,
                                enumerationName,
                                valueName,
                                caption: caption || valueName
                            };
                        }

                        // ============================================================
                        // PAGE, SNIPPET & BUILDING BLOCK OPERATIONS (Group D)
                        // ============================================================

                        else if (operation === "web_create_snippet") {
                            const { moduleName, snippetName, widgetType, widgetOptions } = args;

                            const modules = await studioPro.app.model.projects.getModules();
                            const mod = modules.find((m: any) => m.name === moduleName);
                            if (!mod) throw new Error(`Module '${moduleName}' not found`);

                            const snippetOptions: any = { name: snippetName };

                            const snippet = await studioPro.app.model.snippets.addSnippet(mod.$ID, snippetOptions);

                            // Save first to commit unit to model
                            await studioPro.app.model.snippets.save(snippet);

                            // If widgetType specified, add widget after save (unit must be committed first)
                            let widget: any = null;
                            if (widgetType) {
                                const addMethodName = `add${widgetType}`;
                                if (typeof snippet[addMethodName] === "function") {
                                    widget = await snippet[addMethodName](widgetOptions || {});
                                    await studioPro.app.model.snippets.save(snippet);
                                    addLog(`${widgetType} added to snippet '${snippetName}'`);
                                } else {
                                    const methods = Object.keys(snippet)
                                        .filter((k: string) => typeof snippet[k] === 'function' && k.startsWith('add'));
                                    addLog(`Warning: Widget type '${widgetType}' not supported. Available: ${methods.join(', ')}`);
                                }
                            }

                            addLog(`Snippet '${snippetName}' created in ${moduleName}`);

                            result = {
                                success: true,
                                snippetId: snippet?.$ID,
                                snippetName,
                                moduleName,
                                widgetAdded: widget ? { id: widget.$ID, type: widget.$Type, name: widget.name } : null
                            };
                        }

                        else if (operation === "web_add_widget_to_snippet") {
                            const { moduleName, snippetName, widgetType, widgetOptions } = args;

                            // Try to load snippet — multiple strategies
                            let snippet: any = null;
                            const loadErrors: string[] = [];

                            // Strategy 1: snippets.loadAll
                            try {
                                const results = await studioPro.app.model.snippets.loadAll(
                                    (u: any) => u.name === snippetName || u.name === `${moduleName}.${snippetName}`,
                                    1
                                );
                                if (results && results.length > 0) snippet = results[0];
                            } catch (e: any) { loadErrors.push(`loadAll: ${e.message?.slice(0, 80)}`); }

                            if (!snippet) {
                                // Strategy 2: loadUnitByName
                                for (const name of [snippetName, `${moduleName}.${snippetName}`]) {
                                    try {
                                        const s = await studioPro.app.model.snippets.loadUnitByName(name);
                                        if (s) { snippet = s; break; }
                                    } catch (e: any) { loadErrors.push(`loadByName(${name}): ${e.message?.slice(0, 80)}`); }
                                }
                            }

                            if (!snippet) {
                                // Strategy 3: loadUnits with ID
                                try {
                                    const snippetId = await findSnippetId(snippetName, moduleName);
                                    const res = await studioPro.app.model.snippets.loadUnits("Pages$Snippet", [snippetId]);
                                    snippet = Array.isArray(res) ? res[0] : res;
                                    if (snippet && typeof snippet.then === 'function') snippet = await snippet;
                                } catch (e: any) { loadErrors.push(`snippets.loadUnits: ${e.message?.slice(0, 80)}`); }
                            }

                            if (!snippet) {
                                throw new Error(
                                    `Cannot load snippet '${snippetName}' for editing. ` +
                                    `The Web Extension API does not support loading existing snippets. ` +
                                    `Use web_create_snippet with widget_type parameter to add widgets during creation instead.`
                                );
                            }

                            const addMethodName = `add${widgetType}`;
                            if (typeof snippet[addMethodName] !== "function") {
                                const methods = Object.keys(snippet)
                                    .filter((k: string) => typeof snippet[k] === 'function' && k.startsWith('add'));
                                throw new Error(`Widget type '${widgetType}' not supported on snippet. Available: ${methods.join(', ')}`);
                            }

                            const widget = await snippet[addMethodName](widgetOptions || {});
                            try {
                                await studioPro.app.model.snippets.save(snippet);
                            } catch {
                                await studioPro.app.model.pages.save(snippet);
                            }
                            addLog(`${widgetType} added to snippet '${snippetName}'`);

                            result = {
                                success: true,
                                widgetId: widget?.$ID,
                                widgetType: widget?.$Type,
                                name: widget?.name,
                                snippetName
                            };
                        }

                        else if (operation === "web_create_building_block") {
                            const { moduleName, blockName, platform, widgetType, widgetOptions } = args;

                            const modules = await studioPro.app.model.projects.getModules();
                            const mod = modules.find((m: any) => m.name === moduleName);
                            if (!mod) throw new Error(`Module '${moduleName}' not found`);

                            const blockOptions: any = { name: blockName };

                            const block = await studioPro.app.model.buildingBlocks.addBuildingBlock(mod.$ID, blockOptions);
                            // Set platform after creation if specified (not part of creation options)
                            if (platform && block) {
                                try { block.platform = platform; } catch { /* platform may be read-only */ }
                            }

                            // Save first to commit unit to model
                            await studioPro.app.model.buildingBlocks.save(block);

                            // If widgetType specified, add widget after save (unit must be committed first)
                            let widget: any = null;
                            if (widgetType) {
                                const addMethodName = `add${widgetType}`;
                                if (typeof block[addMethodName] === "function") {
                                    widget = await block[addMethodName](widgetOptions || {});
                                    await studioPro.app.model.buildingBlocks.save(block);
                                    addLog(`${widgetType} added to building block '${blockName}'`);
                                } else {
                                    const methods = Object.keys(block)
                                        .filter((k: string) => typeof block[k] === 'function' && k.startsWith('add'));
                                    addLog(`Warning: Widget type '${widgetType}' not supported. Available: ${methods.join(', ')}`);
                                }
                            }

                            addLog(`Building block '${blockName}' created in ${moduleName}`);

                            result = {
                                success: true,
                                blockId: block?.$ID,
                                blockName,
                                moduleName,
                                platform: block?.platform || platform || "Web",
                                widgetAdded: widget ? { id: widget.$ID, type: widget.$Type, name: widget.name } : null
                            };
                        }

                        else if (operation === "web_add_widget_to_building_block") {
                            const { moduleName, blockName, widgetType, widgetOptions } = args;

                            // Try to load building block — multiple strategies
                            let block: any = null;
                            const loadErrors: string[] = [];

                            // Strategy 1: buildingBlocks.loadAll
                            try {
                                const results = await studioPro.app.model.buildingBlocks.loadAll(
                                    (u: any) => u.name === blockName || u.name === `${moduleName}.${blockName}`,
                                    1
                                );
                                if (results && results.length > 0) block = results[0];
                            } catch (e: any) { loadErrors.push(`loadAll: ${e.message?.slice(0, 80)}`); }

                            if (!block) {
                                // Strategy 2: loadUnitByName
                                for (const name of [blockName, `${moduleName}.${blockName}`]) {
                                    try {
                                        const b = await studioPro.app.model.buildingBlocks.loadUnitByName(name);
                                        if (b) { block = b; break; }
                                    } catch (e: any) { loadErrors.push(`loadByName(${name}): ${e.message?.slice(0, 80)}`); }
                                }
                            }

                            if (!block) {
                                // Strategy 3: loadUnits with ID
                                try {
                                    const blockId = await findBuildingBlockId(blockName, moduleName);
                                    const res = await studioPro.app.model.buildingBlocks.loadUnits("Pages$BuildingBlock", [blockId]);
                                    block = Array.isArray(res) ? res[0] : res;
                                    if (block && typeof block.then === 'function') block = await block;
                                } catch (e: any) { loadErrors.push(`buildingBlocks.loadUnits: ${e.message?.slice(0, 80)}`); }
                            }

                            if (!block) {
                                throw new Error(
                                    `Cannot load building block '${blockName}' for editing. ` +
                                    `The Web Extension API does not support loading existing building blocks. ` +
                                    `Use web_create_building_block with widget_type parameter to add widgets during creation instead.`
                                );
                            }

                            const addMethodName = `add${widgetType}`;
                            if (typeof block[addMethodName] !== "function") {
                                const methods = Object.keys(block)
                                    .filter((k: string) => typeof block[k] === 'function' && k.startsWith('add'));
                                throw new Error(`Widget type '${widgetType}' not supported on building block. Available: ${methods.join(', ')}`);
                            }

                            const widget = await block[addMethodName](widgetOptions || {});
                            try {
                                await studioPro.app.model.buildingBlocks.save(block);
                            } catch {
                                await studioPro.app.model.pages.save(block);
                            }
                            addLog(`${widgetType} added to building block '${blockName}'`);

                            result = {
                                success: true,
                                widgetId: widget?.$ID,
                                widgetType: widget?.$Type,
                                name: widget?.name,
                                blockName
                            };
                        }

                        else if (operation === "web_set_widget_datasource") {
                            const { pageName, moduleName, widgetName, datasourceType, entityName, xpathConstraint, microflowName } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);

                            // Find widget recursively across all placeholders
                            let targetWidget: any = null;
                            if (page?.layoutCall?.arguments) {
                                for (const arg of page.layoutCall.arguments) {
                                    targetWidget = findWidgetByName(arg.widgets || [], widgetName);
                                    if (targetWidget) break;
                                }
                            }
                            if (!targetWidget) throw new Error(`Widget '${widgetName}' not found in page '${pageName}'`);

                            // Use concrete datasource type names (abstract types like Pages$XPathSource are not creatable)
                            const typeMap: Record<string, string[]> = {
                                "database": ["Pages$ListViewXPathSource", "Pages$GridXPathSource"],
                                "xpath": ["Pages$ListViewXPathSource", "Pages$GridXPathSource"],
                                "microflow": ["Pages$MicroflowSource"],
                                "nanoflow": ["Pages$NanoflowSource"],
                                "association": ["Pages$AssociationSource"],
                                "dataview": ["Pages$DataViewSource"],
                                "listen": ["Pages$ListenTargetSource"],
                            };
                            const typeNames = typeMap[datasourceType];
                            if (!typeNames) {
                                throw new Error(`Unsupported datasource type '${datasourceType}'. Use: database, xpath, microflow, nanoflow, association, dataview, listen`);
                            }

                            let dsSource: any = null;
                            const createErrors: string[] = [];
                            for (const typeName of typeNames) {
                                try {
                                    dsSource = await studioPro.app.model.pages.createElement(typeName);
                                    break;
                                } catch (e: any) {
                                    createErrors.push(`${typeName}: ${e.message?.slice(0, 50)}`);
                                }
                            }

                            if (dsSource) {
                                // Concrete types use entityRef (not entity) for entity references
                                if (entityName) {
                                    try {
                                        // Try creating a DirectEntityRef for the entity reference
                                        const entityRef = await studioPro.app.model.pages.createElement("DomainModels$DirectEntityRef");
                                        if (entityRef) {
                                            entityRef.entity = entityName;
                                            dsSource.entityRef = entityRef;
                                        }
                                    } catch {
                                        // Fallback: try direct entity assignment
                                        try { dsSource.entityRef = entityName; } catch {
                                            try { dsSource.entity = entityName; } catch { /* best effort */ }
                                        }
                                    }
                                }
                                if (xpathConstraint) {
                                    try { dsSource.xPathConstraint = xpathConstraint; } catch {
                                        try { dsSource.xpathConstraint = xpathConstraint; } catch { /* best effort */ }
                                    }
                                }
                                if (microflowName) {
                                    try { dsSource.microflow = microflowName; } catch {
                                        try { dsSource.microflowSettings = { microflow: microflowName }; } catch { /* best effort */ }
                                    }
                                }
                                targetWidget.dataSource = dsSource;
                            } else {
                                // Fallback: try setting entity directly on widget
                                try {
                                    targetWidget.entity = entityName;
                                } catch {
                                    throw new Error(`Cannot set datasource: createElement failed for all types [${createErrors.join('; ')}], and direct entity assignment also failed.`);
                                }
                            }

                            await studioPro.app.model.pages.save(page);
                            addLog(`Datasource set on widget '${widgetName}' (${datasourceType})`);

                            result = {
                                success: true,
                                widgetName,
                                datasourceType,
                                entityName: entityName || null,
                                microflowName: microflowName || null
                            };
                        }

                        else if (operation === "web_configure_widget_property") {
                            const { pageName, moduleName, widgetName, propertyName, propertyValue } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);

                            let targetWidget: any = null;
                            if (page?.layoutCall?.arguments) {
                                for (const arg of page.layoutCall.arguments) {
                                    targetWidget = findWidgetByName(arg.widgets || [], widgetName);
                                    if (targetWidget) break;
                                }
                            }
                            if (!targetWidget) throw new Error(`Widget '${widgetName}' not found in page '${pageName}'`);

                            // Handle translation properties (caption, label, etc.)
                            if (targetWidget[propertyName] && typeof targetWidget[propertyName].addTranslation === 'function') {
                                // It's a translatable text property
                                if (Array.isArray(targetWidget[propertyName].translations)) {
                                    const existing = targetWidget[propertyName].translations.filter((t: any) => t.languageCode === "en_US");
                                    for (const t of existing) {
                                        if (typeof t.delete === 'function') t.delete();
                                    }
                                }
                                await targetWidget[propertyName].addTranslation({ languageCode: "en_US", text: propertyValue });
                            } else {
                                // Direct property assignment — wrap to give better error
                                try {
                                    targetWidget[propertyName] = propertyValue;
                                } catch (propErr: any) {
                                    // List available properties for help
                                    const widgetKeys = Object.keys(targetWidget).filter(k => !k.startsWith('$'));
                                    throw new Error(`Cannot set '${propertyName}' to '${propertyValue}': ${propErr.message}. Available properties: ${widgetKeys.join(', ')}`);
                                }
                            }

                            await studioPro.app.model.pages.save(page);
                            addLog(`Property '${propertyName}' set on widget '${widgetName}'`);

                            result = {
                                success: true,
                                widgetName,
                                propertyName,
                                propertyValue
                            };
                        }

                        else if (operation === "web_duplicate_page") {
                            const { sourcePageName, sourceModuleName, targetPageName, targetModuleName } = args;
                            const sourcePageId = await findPageId(sourcePageName, sourceModuleName);

                            const modules = await studioPro.app.model.projects.getModules();
                            const targetMod = modules.find((m: any) => m.name === (targetModuleName || sourceModuleName));
                            if (!targetMod) throw new Error(`Target module '${targetModuleName || sourceModuleName}' not found`);

                            // Use the model's copy functionality
                            const duplicatedPage = await studioPro.app.model.pages.duplicatePage(sourcePageId, targetMod.$ID, targetPageName);

                            addLog(`Page '${sourcePageName}' duplicated as '${targetPageName}'`);

                            result = {
                                success: true,
                                sourcePageName,
                                targetPageName,
                                targetModuleName: targetModuleName || sourceModuleName,
                                newPageId: duplicatedPage?.$ID
                            };
                        }

                        else if (operation === "web_list_widget_types") {
                            const { pageName, moduleName } = args;
                            const pageId = args.pageId || await findPageId(pageName, moduleName);
                            const page = await loadPage(pageId);

                            const widgetTypes: any[] = [];

                            if (page?.layoutCall?.arguments) {
                                for (const arg of page.layoutCall.arguments) {
                                    const addMethods = Object.keys(arg)
                                        .filter((k: string) => typeof arg[k] === 'function' && k.startsWith('add'));

                                    widgetTypes.push({
                                        placeholder: arg.parameter,
                                        availableWidgetTypes: addMethods.map((m: string) => m.replace('add', '')),
                                        currentWidgetCount: arg.widgets?.length || 0
                                    });
                                }
                            }

                            result = {
                                success: true,
                                pageName,
                                placeholders: widgetTypes
                            };
                        }

                        // ============================================================
                        // EDITOR OPERATIONS
                        // ============================================================

                        else if (operation === "open_document") {
                            const { documentName, moduleName, documentType } = args;

                            // Search across known unit types using getUnitsInfo
                            const unitTypes: Array<{ subsystem: any; type: string }> = [
                                { subsystem: studioPro.app.model.pages, type: "Pages$Page" },
                                { subsystem: studioPro.app.model.microflows, type: "Microflows$Microflow" },
                                { subsystem: studioPro.app.model.workflows, type: "Workflows$Workflow" },
                                { subsystem: studioPro.app.model.enumerations, type: "Enumerations$Enumeration" },
                                { subsystem: studioPro.app.model.pages, type: "Pages$Snippet" },
                                { subsystem: studioPro.app.model.pages, type: "Pages$BuildingBlock" },
                                { subsystem: studioPro.app.model.pages, type: "Layouts$Layout" },
                            ];

                            let docId: string | null = null;
                            for (const { subsystem, type } of unitTypes) {
                                if (documentType && !type.includes(documentType)) continue;
                                try {
                                    const units = await subsystem.getUnitsInfo(type);
                                    if (!units) continue;
                                    for (const u of units) {
                                        if (u.name === documentName) {
                                            if (!moduleName || (u.qualifiedName && u.qualifiedName.startsWith(`${moduleName}.`))) {
                                                docId = u.$ID;
                                                break;
                                            }
                                        }
                                    }
                                    if (docId) break;
                                } catch { /* subsystem may not support this type */ }
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
