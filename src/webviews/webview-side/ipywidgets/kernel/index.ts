// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
/* eslint-disable no-console */
import type * as nbformat from '@jupyterlab/nbformat';
import { logMessage } from '../../react-common/logger';
import { KernelMessagingApi, PostOffice } from '../../react-common/postOffice';
import { WidgetManager } from '../common/manager';
import { ScriptManager } from '../common/scriptManager';
import { OutputItem } from 'vscode-notebook-renderer';
import {
    SharedMessages,
    IInteractiveWindowMapping,
    InteractiveWindowMessages
} from '../../../../platform/messageTypes';

class WidgetManagerComponent {
    private readonly widgetManager: WidgetManager;
    private readonly scriptManager: ScriptManager;
    private widgetsCanLoadFromCDN: boolean = false;
    constructor(private postOffice: PostOffice) {
        this.scriptManager = new ScriptManager(postOffice);
        this.scriptManager.onWidgetLoadError(this.handleLoadError.bind(this));
        this.scriptManager.onWidgetLoadSuccess(this.handleLoadSuccess.bind(this));
        this.scriptManager.onWidgetVersionNotSupported(this.handleUnsupportedWidgetVersion.bind(this));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.widgetManager = new WidgetManager(undefined as any, postOffice, this.scriptManager.getScriptLoader());

        postOffice.addHandler({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handleMessage: (type: string, payload?: any) => {
                if (type === SharedMessages.UpdateSettings) {
                    const settings = JSON.parse(payload);
                    this.widgetsCanLoadFromCDN = settings.widgetScriptSources.length > 0;
                }
                return true;
            }
        });
    }
    public dispose() {
        this.widgetManager.dispose();
    }
    private async handleLoadError(data: {
        className: string;
        moduleName: string;
        moduleVersion: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: any;
        timedout?: boolean;
        isOnline: boolean;
    }) {
        this.postOffice.sendMessage<IInteractiveWindowMapping>(InteractiveWindowMessages.IPyWidgetLoadFailure, {
            className: data.className,
            moduleName: data.moduleName,
            moduleVersion: data.moduleVersion,
            cdnsUsed: this.widgetsCanLoadFromCDN,
            isOnline: data.isOnline,
            timedout: data.timedout,
            error: data.error
        });
        console.error(`Failed to to Widget load class ${data.moduleName}${data.className}`, data);
    }

    private handleUnsupportedWidgetVersion(data: { moduleName: 'qgrid'; moduleVersion: string }) {
        this.postOffice.sendMessage<IInteractiveWindowMapping>(
            InteractiveWindowMessages.IPyWidgetWidgetVersionNotSupported,
            {
                moduleName: data.moduleName,
                moduleVersion: data.moduleVersion
            }
        );
    }

    private handleLoadSuccess(data: { className: string; moduleName: string; moduleVersion: string }) {
        this.postOffice.sendMessage<IInteractiveWindowMapping>(InteractiveWindowMessages.IPyWidgetLoadSuccess, {
            className: data.className,
            moduleName: data.moduleName,
            moduleVersion: data.moduleVersion
        });
    }
}

const outputDisposables = new Map<string, { dispose(): void }>();
const htmlDisposables = new WeakMap<HTMLElement, { dispose(): void }>();
const renderedWidgets = new Set<string>();
/**
 * Called from renderer to render output.
 * This will be exposed as a public method on window for renderer to render output.
 */
let stackOfWidgetsRenderStatusByOutputId: { outputId: string; container: HTMLElement; success?: boolean }[] = [];
export function renderOutput(outputItem: OutputItem, element: HTMLElement, logger: (message: string) => void) {
    try {
        stackOfWidgetsRenderStatusByOutputId.push({ outputId: outputItem.id, container: element });
        const output = convertVSCodeOutputToExecuteResultOrDisplayData(outputItem);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const model = output.data['application/vnd.jupyter.widget-view+json'] as any;
        if (!model) {
            logger(`Error: Model not found to render output ${outputItem.id}`);
            // eslint-disable-next-line no-console
            return console.error('Nothing to render');
        }
        /* eslint-disable no-console */
        renderIPyWidget(outputItem.id, model, element, logger);
    } catch (ex) {
        logger(`Error: render output ${outputItem.id} failed ${ex.toString()}`);
        console.error(`Failed to render ipywidget type`, ex);
        throw ex;
    }
}
export function disposeOutput(outputId?: string) {
    if (outputId) {
        stackOfWidgetsRenderStatusByOutputId = stackOfWidgetsRenderStatusByOutputId.filter(
            (item) => !(outputId in item)
        );
    }
}
function renderIPyWidget(
    outputId: string,
    model: nbformat.IMimeBundle & { model_id: string; version_major: number },
    container: HTMLElement,
    logger: (message: string) => void
) {
    if (renderedWidgets.has(outputId)) {
        return console.error('already rendering');
    }
    const output = document.createElement('div');
    output.className = 'cell-output cell-output';
    const ele = document.createElement('div');
    ele.className = 'cell-output-ipywidget-background';
    container.appendChild(ele);
    ele.appendChild(output);
    renderedWidgets.add(outputId);
    createWidgetView(model, ele)
        .then((w) => {
            const disposable = {
                dispose: () => {
                    // What if we render the same model in two cells.
                    renderedWidgets.delete(outputId);
                    w?.dispose();
                }
            };
            outputDisposables.set(outputId, disposable);
            htmlDisposables.set(ele, disposable);
            // Keep track of the fact that we have successfully rendered a widget for this outputId.
            const statusInfo = stackOfWidgetsRenderStatusByOutputId.find((item) => item.outputId === outputId);
            if (statusInfo) {
                statusInfo.success = true;
            }
        })
        .catch((ex) => {
            logger(`Error: Failed to render ${outputId}, ${ex.toString()}`);
            console.error('Failed to render', ex);
        });
}

let widgetManagerPromise: Promise<WidgetManager> | undefined;
async function getWidgetManager(): Promise<WidgetManager> {
    if (!widgetManagerPromise) {
        function reInitializeWidgetManager(resolve?: (value: WidgetManager) => void) {
            WidgetManager.instance.subscribe((wm) => {
                if (wm) {
                    const oldDispose = wm.dispose.bind(wm);
                    wm.dispose = () => {
                        // eslint-disable-next-line , @typescript-eslint/no-explicit-any
                        widgetManagerPromise = undefined;
                        return oldDispose();
                    };
                    if (resolve) {
                        resolve(wm);
                        resolve = undefined;
                    }
                    widgetManagerPromise = Promise.resolve(wm);
                }
            });
        }
        // eslint-disable-next-line , @typescript-eslint/no-explicit-any
        widgetManagerPromise = new Promise((resolve) => reInitializeWidgetManager(resolve as any));
    }
    return widgetManagerPromise;
}

async function createWidgetView(
    widgetData: nbformat.IMimeBundle & { model_id: string; version_major: number },
    element: HTMLElement
) {
    try {
        const wm = await getWidgetManager();
        return await wm?.renderWidget(widgetData, element);
    } catch (ex) {
        // eslint-disable-next-line no-console
        console.error('Failed to render widget', ex);
    }
}

function initialize(context?: KernelMessagingApi) {
    try {
        // Setup the widget manager
        const postOffice = new PostOffice(context);
        const mgr = new WidgetManagerComponent(postOffice);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any)._mgr = mgr;
    } catch (ex) {
        // eslint-disable-next-line no-console
        console.error('Exception initializing WidgetManager', ex);
    }
}

function convertVSCodeOutputToExecuteResultOrDisplayData(
    outputItem: OutputItem
): nbformat.IExecuteResult | nbformat.IDisplayData {
    return {
        data: {
            [outputItem.mime]: outputItem.mime.toLowerCase().includes('json') ? outputItem.json() : outputItem.text()
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: (outputItem.metadata as any) || {},
        execution_count: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        output_type: (outputItem.metadata as any)?.outputType || 'execute_result'
    };
}

// Create our window exports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ipywidgetsKernel = {
    renderOutput,
    disposeOutput
};

let capturedContext: KernelMessagingApi | undefined;
// To ensure we initialize after the other scripts, wait for them.
function attemptInitialize(context?: KernelMessagingApi) {
    capturedContext = capturedContext || context;
    console.log('Attempt Initialize IpyWidgets kernel.js', context);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).vscIPyWidgets) {
        logMessage('IPyWidget kernel initializing...');
        initialize(capturedContext);
    } else {
        setTimeout(attemptInitialize, 100);
    }
}

// Has to be this form for VS code to load it correctly
export function activate(context?: KernelMessagingApi) {
    return attemptInitialize(context);
}
