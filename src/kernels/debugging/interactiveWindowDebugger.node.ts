// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import type * as nbformat from '@jupyterlab/nbformat';
import { inject, injectable, named } from 'inversify';
import { DebugConfiguration, Disposable, NotebookDocument } from 'vscode';
import { IPythonDebuggerPathProvider } from '../../platform/api/types';
import { traceInfo, traceInfoIfCI, traceWarning } from '../../platform/logging';
import { IPlatformService } from '../../platform/common/platform/types';
import { IConfigurationService } from '../../platform/common/types';
import { DataScience } from '../../platform/common/utils/localize';
import { Identifiers, Telemetry } from '../../webviews/webview-side/common/constants';
import { JupyterDebuggerNotInstalledError } from '../../platform/errors/jupyterDebuggerNotInstalledError.node';
import { JupyterDebuggerRemoteNotSupportedError } from '../../platform/errors/jupyterDebuggerRemoteNotSupportedError.node';
import { executeSilently } from '../helpers.node';
import { getPlainTextOrStreamOutput } from '../kernel.node';
import { IKernel, isLocalConnection } from '../types';
import { IInteractiveWindowDebugger } from '../../interactive-window/types';
import { ICellHashListener, IFileHashes } from '../../interactive-window/editor-integration/types';
import { IJupyterDebugService, ISourceMapRequest } from './types';
import { getAssociatedNotebookDocument } from '../../notebooks/controllers/kernelSelector.node';

@injectable()
export class InteractiveWindowDebugger implements IInteractiveWindowDebugger, ICellHashListener {
    private configs: WeakMap<NotebookDocument, DebugConfiguration> = new WeakMap<
        NotebookDocument,
        DebugConfiguration
    >();
    private readonly debuggerPackage: string;
    private readonly enableDebuggerCode: string;
    private readonly waitForDebugClientCode: string;
    private readonly tracingEnableCode: string;
    private readonly tracingDisableCode: string;
    private debuggingActive: boolean = false;
    constructor(
        @inject(IPythonDebuggerPathProvider) private readonly debuggerPathProvider: IPythonDebuggerPathProvider,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IJupyterDebugService)
        @named(Identifiers.MULTIPLEXING_DEBUGSERVICE)
        private debugService: IJupyterDebugService,
        @inject(IPlatformService) private platform: IPlatformService
    ) {
        this.debuggerPackage = 'debugpy';
        this.enableDebuggerCode = `import debugpy;debugpy.listen(('localhost', 0))`;
        this.waitForDebugClientCode = `import debugpy;debugpy.wait_for_client()`;
        this.tracingEnableCode = `from debugpy import trace_this_thread;trace_this_thread(True)`;
        this.tracingDisableCode = `from debugpy import trace_this_thread;trace_this_thread(False)`;
    }
    public async attach(kernel: IKernel): Promise<void> {
        if (!kernel.session) {
            throw new Error('Notebook not initialized');
        }

        const settings = this.configService.getSettings(kernel.resourceUri);

        // The python extension debugger tags the debug configuration with the python path used on the python property
        // by tagging this here (if available) we can treat IW or python extension debug session the same in knowing
        // which python launched them
        const pythonPath = kernel.kernelConnectionMetadata.interpreter?.path;

        return this.startDebugSession((c) => this.debugService.startDebugging(undefined, c), kernel, {
            justMyCode: settings.debugJustMyCode,
            python: pythonPath
        });
    }

    public async detach(kernel: IKernel): Promise<void> {
        const notebook = getAssociatedNotebookDocument(kernel);
        if (!kernel.session || !notebook) {
            return;
        }
        const config = this.configs.get(notebook);
        if (config) {
            traceInfo('stop debugging');

            // Tell our debug service to shutdown if possible
            this.debuggingActive = false;
            this.debugService.stop();

            // Disable tracing after we disconnect because we don't want to step through this
            // code if the user was in step mode.
            if (kernel.status !== 'dead' && kernel.status !== 'unknown') {
                this.disable(kernel);
            }
        }
    }

    public async hashesUpdated(hashes: IFileHashes[]): Promise<void> {
        // Make sure that we have an active debugging session at this point
        if (this.debugService.activeDebugSession && this.debuggingActive) {
            traceInfoIfCI(`Sending debug request for source map`);
            await Promise.all(
                hashes.map(async (fileHash) => {
                    if (this.debuggingActive) {
                        return this.debugService.activeDebugSession!.customRequest(
                            'setPydevdSourceMap',
                            this.buildSourceMap(fileHash)
                        );
                    }
                })
            );
        }
    }

    public enable(kernel: IKernel) {
        if (!kernel.session) {
            return;
        }
        executeSilently(kernel.session, this.tracingEnableCode, {
            traceErrors: true,
            traceErrorsMessage: 'Execute_request failure enabling tracing code for IW',
            telemetryName: Telemetry.InteractiveWindowDebugSetupCodeFailure
        }).ignoreErrors();
    }

    public disable(kernel: IKernel) {
        if (!kernel.session) {
            return;
        }
        executeSilently(kernel.session, this.tracingDisableCode, {
            traceErrors: true,
            traceErrorsMessage: 'Execute_request failure disabling tracing code for IW',
            telemetryName: Telemetry.InteractiveWindowDebugSetupCodeFailure
        }).ignoreErrors();
    }

    private async startDebugSession(
        startCommand: (config: DebugConfiguration) => Thenable<boolean>,
        kernel: IKernel,
        extraConfig: Partial<DebugConfiguration>
    ) {
        traceInfo('start debugging');
        if (!kernel.session) {
            return;
        }
        // Try to connect to this notebook
        const config = await this.connect(kernel, extraConfig);
        if (config) {
            traceInfo('connected to notebook during debugging');

            this.debuggingActive = await startCommand(config);

            if (this.debuggingActive) {
                // Force the debugger to update its list of breakpoints. This is used
                // to make sure the breakpoint list is up to date when we do code file hashes
                this.debugService.removeBreakpoints([]);

                // Wait for attach before we turn on tracing and allow the code to run, if the IDE is already attached this is just a no-op
                const importResults = await executeSilently(kernel.session, this.waitForDebugClientCode, {
                    traceErrors: true,
                    traceErrorsMessage: 'Execute_request failure starting debug session for IW',
                    telemetryName: Telemetry.InteractiveWindowDebugSetupCodeFailure
                });
                if (importResults.some((item) => item.output_type === 'error')) {
                    traceWarning(`${this.debuggerPackage} not found in path.`);
                } else {
                    traceInfo(`import startup: ${getPlainTextOrStreamOutput(importResults)}`);
                }

                // After attach initially disable debugging
                await this.disable(kernel);
            }
        }
    }

    private async connect(
        kernel: IKernel,
        extraConfig: Partial<DebugConfiguration>
    ): Promise<DebugConfiguration | undefined> {
        const notebook = getAssociatedNotebookDocument(kernel);
        if (!kernel || !notebook) {
            return;
        }
        // If we already have configuration, we're already attached, don't do it again.
        const key = notebook;
        let result = this.configs.get(key);
        if (result) {
            return {
                ...result,
                ...extraConfig
            };
        }
        traceInfo('enable debugger attach');

        // Append any specific debugger paths that we have
        await this.appendDebuggerPaths(kernel);

        // Connect local or remote based on what type of notebook we're talking to
        result = {
            type: 'python',
            name: 'IPython',
            request: 'attach',
            ...extraConfig
        };
        if (isLocalConnection(kernel.kernelConnectionMetadata)) {
            const { host, port } = await this.connectToLocal(kernel);
            result.host = host;
            result.port = port;
        } else {
            const { host, port } = await this.connectToRemote(kernel);
            result.host = host;
            result.port = port;
        }

        if (result.port) {
            this.configs.set(notebook, result);

            // Sign up for any change to the kernel to delete this config.
            const disposables: Disposable[] = [];
            const clear = () => {
                this.configs.delete(key);
                disposables.forEach((d) => d.dispose());
            };
            disposables.push(kernel.onDisposed(clear));
            disposables.push(kernel.onRestarted(clear));
        }

        return result;
    }

    private async calculateDebuggerPathList(kernel: IKernel): Promise<string | undefined> {
        const extraPaths: string[] = [];

        // Add the settings path first as it takes precedence over the ptvsd extension path
        // eslint-disable-next-line no-multi-str
        let settingsPath = this.configService.getSettings(kernel.resourceUri).debugpyDistPath;
        // Escape windows path chars so they end up in the source escaped
        if (settingsPath) {
            if (this.platform.isWindows) {
                settingsPath = settingsPath.replace(/\\/g, '\\\\');
            }

            extraPaths.push(settingsPath);
        }

        // For a local connection we also need will append on the path to the debugger
        // installed locally by the extension
        // Actually until this is resolved: https://github.com/microsoft/vscode-python/issues/7615, skip adding
        // this path.
        if (isLocalConnection(kernel.kernelConnectionMetadata)) {
            let localPath = await this.debuggerPathProvider.getDebuggerPath();
            if (this.platform.isWindows) {
                localPath = localPath.replace(/\\/g, '\\\\');
            }
            extraPaths.push(localPath);
        }

        if (extraPaths && extraPaths.length > 0) {
            return extraPaths.reduce((totalPath, currentPath) => {
                if (totalPath.length === 0) {
                    totalPath = `'${currentPath}'`;
                } else {
                    totalPath = `${totalPath}, '${currentPath}'`;
                }

                return totalPath;
            }, '');
        }

        return undefined;
    }

    // Append our local debugger path and debugger settings path to sys.path
    private async appendDebuggerPaths(kernel: IKernel): Promise<void> {
        const debuggerPathList = await this.calculateDebuggerPathList(kernel);

        if (debuggerPathList && debuggerPathList.length > 0) {
            const result = kernel.session
                ? await executeSilently(
                      kernel.session,
                      `import sys\r\nsys.path.extend([${debuggerPathList}])\r\nsys.path`,
                      {
                          traceErrors: true,
                          traceErrorsMessage: 'Execute_request failure appending debugger paths for IW',
                          telemetryName: Telemetry.InteractiveWindowDebugSetupCodeFailure
                      }
                  )
                : [];
            traceInfo(`Appending paths: ${getPlainTextOrStreamOutput(result)}`);
        }
    }

    private buildSourceMap(fileHash: IFileHashes): ISourceMapRequest {
        const sourceMapRequest: ISourceMapRequest = { source: { path: fileHash.uri.fsPath }, pydevdSourceMaps: [] };
        sourceMapRequest.pydevdSourceMaps = fileHash.hashes.map((cellHash) => {
            return {
                line: cellHash.debuggerStartLine,
                endLine: cellHash.endLine,
                runtimeSource: {
                    path: cellHash.runtimeFile
                },
                runtimeLine: cellHash.runtimeLine
            };
        });

        return sourceMapRequest;
    }

    private async connectToLocal(kernel: IKernel): Promise<{ port: number; host: string }> {
        const outputs = kernel.session
            ? await executeSilently(kernel.session, this.enableDebuggerCode, {
                  traceErrors: true,
                  traceErrorsMessage: 'Execute_request failure enabling debugging for IW',
                  telemetryName: Telemetry.InteractiveWindowDebugSetupCodeFailure
              })
            : [];

        // Pull our connection info out from the cells returned by enable_attach
        if (outputs.length > 0) {
            let enableAttachString = getPlainTextOrStreamOutput(outputs);
            if (enableAttachString) {
                enableAttachString = enableAttachString.trimQuotes();

                // Important: This regex matches the format of the string returned from enable_attach. When
                // doing enable_attach remotely, make sure to print out a string in the format ('host', port)
                const debugInfoRegEx = /\('(.*?)', ([0-9]*)\)/;
                const debugInfoMatch = debugInfoRegEx.exec(enableAttachString);
                if (debugInfoMatch) {
                    return {
                        port: parseInt(debugInfoMatch[2], 10),
                        host: debugInfoMatch[1]
                    };
                }
            }
        }
        // if we cannot parse the connect information, throw so we exit out of debugging
        if (outputs.length > 0 && outputs[0].output_type === 'error') {
            const error = outputs[0] as nbformat.IError;
            throw new JupyterDebuggerNotInstalledError(
                this.debuggerPackage,
                error.ename,
                kernel.kernelConnectionMetadata
            );
        }
        throw new JupyterDebuggerNotInstalledError(
            DataScience.jupyterDebuggerOutputParseError().format(this.debuggerPackage),
            undefined,
            kernel.kernelConnectionMetadata
        );
    }

    private async connectToRemote(kernel: IKernel): Promise<{ port: number; host: string }> {
        // We actually need a token. This isn't supported at the moment
        throw new JupyterDebuggerRemoteNotSupportedError(kernel.kernelConnectionMetadata);

        //         let portNumber = this.configService.getSettings().remoteDebuggerPort;
        //         if (!portNumber) {
        //             portNumber = -1;
        //         }

        //         // Loop through a bunch of ports until we find one we can use. Note how we
        //         // are connecting to '0.0.0.0' here. That's the location as far as ptvsd is concerned.
        //         const attachCode = portNumber !== -1 ?
        //             `import ptvsd
        // ptvsd.enable_attach(('0.0.0.0', ${portNumber}))
        // print("('${connectionInfo.hostName}', ${portNumber})")` :
        // eslint-disable-next-line no-multi-str
        //             `import ptvsd
        // port = ${Settings.RemoteDebuggerPortBegin}
        // attached = False
        // while not attached and port <= ${Settings.RemoteDebuggerPortEnd}:
        //     try:
        //         ptvsd.enable_attach(('0.0.0.0', port))
        //         print("('${connectionInfo.hostName}', " + str(port) + ")")
        //         attached = True
        //     except Exception as e:
        //         print("Exception: " + str(e))
        //         port +=1`;
        //         const enableDebuggerResults = await this.executeSilently(server, attachCode);

        //         // Save our connection info to this server
        //         const result = this.parseConnectInfo(enableDebuggerResults, false);

        //         // If that didn't work, throw an error so somebody can open the port
        //         if (!result) {
        //             throw new JupyterDebuggerPortNotAvailableError(portNumber, Settings.RemoteDebuggerPortBegin, Settings.RemoteDebuggerPortEnd);
        //         }

        //         // Double check, open a socket? This won't work if we're remote ourselves. Actually the debug adapter runs
        //         // from the remote machine.
        //         try {
        //             const deferred = createDeferred();
        //             const socket = net.createConnection(result.port, result.host, () => {
        //                 deferred.resolve();
        //             });
        //             socket.on('error', (err) => deferred.reject(err));
        //             socket.setTimeout(2000, () => deferred.reject(new Error('Timeout trying to ping remote debugger')));
        //             await deferred.promise;
        //             socket.end();
        //         } catch (exc) {
        //             traceWarning(`Cannot connect to remote debugger at ${result.host}:${result.port} => ${exc}`);
        //             // We can't connect. Must be a firewall issue
        //             throw new JupyterDebuggerPortBlockedError(portNumber, Settings.RemoteDebuggerPortBegin, Settings.RemoteDebuggerPortEnd);
        //         }

        //         return result;
    }
}
