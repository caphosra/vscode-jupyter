// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';

import {
    ICommandManager,
    IDebugService,
    IDocumentManager,
    IWorkspaceService
} from '../../platform/common/application/types';
import { ContextKey } from '../../platform/common/contextKey.node';
import { disposeAllDisposables } from '../../platform/common/helpers.node';
import { IFileSystem } from '../../platform/common/platform/types.node';

import { IConfigurationService, IDisposable, IDisposableRegistry } from '../../platform/common/types';
import { noop } from '../../platform/common/utils/misc';
import { StopWatch } from '../../platform/common/utils/stopWatch';
import { IServiceContainer } from '../../platform/ioc/types';
import { sendTelemetryEvent } from '../../telemetry';
import { traceInfoIfCI } from '../../platform/logging';
import {
    CodeLensCommands,
    EditorContexts,
    PYTHON_FILE,
    PYTHON_UNTITLED,
    Telemetry
} from '../../platform/common/constants';
import { IDebugLocationTracker } from '../../platform/debugger/types';
import { IDataScienceCodeLensProvider, ICodeWatcher } from './types';

@injectable()
export class DataScienceCodeLensProvider implements IDataScienceCodeLensProvider, IDisposable {
    private totalExecutionTimeInMs: number = 0;
    private totalGetCodeLensCalls: number = 0;
    private activeCodeWatchers: ICodeWatcher[] = [];
    private didChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    constructor(
        @inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(IDebugLocationTracker) private debugLocationTracker: IDebugLocationTracker,
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(IConfigurationService) private configuration: IConfigurationService,
        @inject(ICommandManager) private commandManager: ICommandManager,
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry,
        @inject(IDebugService) private debugService: IDebugService,
        @inject(IFileSystem) private fs: IFileSystem,
        @inject(IWorkspaceService) workspace: IWorkspaceService
    ) {
        disposableRegistry.push(this);
        disposableRegistry.push(
            workspace.onDidGrantWorkspaceTrust(() => {
                disposeAllDisposables(this.activeCodeWatchers);
                this.activeCodeWatchers = [];
                this.didChangeCodeLenses.fire();
            })
        );
        disposableRegistry.push(this.debugService.onDidChangeActiveDebugSession(this.onChangeDebugSession.bind(this)));
        disposableRegistry.push(this.documentManager.onDidCloseTextDocument(this.onDidCloseTextDocument.bind(this)));
        disposableRegistry.push(this.debugLocationTracker.updated(this.onDebugLocationUpdated.bind(this)));
    }

    public dispose() {
        // On shutdown send how long on average we spent parsing code lens
        if (this.totalGetCodeLensCalls > 0) {
            sendTelemetryEvent(
                Telemetry.CodeLensAverageAcquisitionTime,
                this.totalExecutionTimeInMs / this.totalGetCodeLensCalls
            );
        }
    }

    public get onDidChangeCodeLenses(): vscode.Event<void> {
        return this.didChangeCodeLenses.event;
    }

    // CodeLensProvider interface
    // Some implementation based on DonJayamanne's jupyter extension work
    public provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
        if (document.uri.scheme != PYTHON_FILE.scheme && document.uri.scheme !== PYTHON_UNTITLED.scheme) {
            return [];
        }
        // Get the list of code lens for this document.
        return this.getCodeLensTimed(document);
    }

    // IDataScienceCodeLensProvider interface
    public getCodeWatcher(document: vscode.TextDocument): ICodeWatcher | undefined {
        return this.matchWatcher(document.uri);
    }

    private onDebugLocationUpdated() {
        this.didChangeCodeLenses.fire();
    }

    private onChangeDebugSession(_e: vscode.DebugSession | undefined) {
        this.didChangeCodeLenses.fire();
    }

    private onDidCloseTextDocument(e: vscode.TextDocument) {
        const index = this.activeCodeWatchers.findIndex((item) => item.uri && item.uri.toString() === e.uri.toString());
        if (index >= 0) {
            this.activeCodeWatchers.splice(index, 1);
        }
    }

    private getCodeLensTimed(document: vscode.TextDocument): vscode.CodeLens[] {
        const stopWatch = new StopWatch();
        const codeLenses = this.getCodeLens(document);
        this.totalExecutionTimeInMs += stopWatch.elapsedTime;
        this.totalGetCodeLensCalls += 1;

        // Update the hasCodeCells context at the same time we are asked for codelens as VS code will
        // ask whenever a change occurs. Do this regardless of if we have code lens turned on or not as
        // shift+enter relies on this code context.
        const editorContext = new ContextKey(EditorContexts.HasCodeCells, this.commandManager);
        editorContext.set(codeLenses && codeLenses.length > 0).catch(noop);

        // Don't provide any code lenses if we have not enabled data science
        const settings = this.configuration.getSettings(document.uri);
        if (!settings.enableCellCodeLens) {
            return [];
        }

        return this.adjustDebuggingLenses(document, codeLenses);
    }

    // Adjust what code lenses are visible or not given debug mode and debug context location
    private adjustDebuggingLenses(document: vscode.TextDocument, lenses: vscode.CodeLens[]): vscode.CodeLens[] {
        const debugCellList = CodeLensCommands.DebuggerCommands;

        if (this.debugService.activeDebugSession) {
            const debugLocation = this.debugLocationTracker.getLocation(this.debugService.activeDebugSession);

            // Debug locations only work on local paths, so check against fsPath here.
            if (debugLocation && this.fs.areLocalPathsSame(debugLocation.fileName, document.uri.fsPath)) {
                // We are in the given debug file, so only return the code lens that contains the given line
                const activeLenses = lenses.filter((lens) => {
                    // -1 for difference between file system one based and debugger zero based
                    const pos = new vscode.Position(debugLocation.lineNumber - 1, debugLocation.column - 1);
                    return lens.range.contains(pos);
                });

                return activeLenses.filter((lens) => {
                    if (lens.command) {
                        return debugCellList.includes(lens.command.command);
                    }
                    return false;
                });
            }
        } else {
            return lenses.filter((lens) => {
                if (lens.command) {
                    return !debugCellList.includes(lens.command.command);
                }
                return false;
            });
        }

        // Fall through case to return nothing
        return [];
    }

    private getCodeLens(document: vscode.TextDocument): vscode.CodeLens[] {
        // See if we already have a watcher for this file and version
        const codeWatcher: ICodeWatcher | undefined = this.matchWatcher(document.uri);
        if (codeWatcher) {
            return codeWatcher.getCodeLenses();
        }

        traceInfoIfCI(`Creating a new watcher for document ${document.uri}`);
        const newCodeWatcher = this.createNewCodeWatcher(document);
        return newCodeWatcher.getCodeLenses();
    }

    private matchWatcher(uri: vscode.Uri): ICodeWatcher | undefined {
        const index = this.activeCodeWatchers.findIndex((item) => item.uri && item.uri.toString() == uri.toString());
        if (index >= 0) {
            return this.activeCodeWatchers[index];
        }

        // Create a new watcher for this file if we can find a matching document
        const possibleDocuments = this.documentManager.textDocuments.filter((d) => d.uri.toString() === uri.toString());
        if (possibleDocuments && possibleDocuments.length > 0) {
            traceInfoIfCI(`creating new code watcher with matching document ${uri}`);
            return this.createNewCodeWatcher(possibleDocuments[0]);
        }

        return undefined;
    }

    private createNewCodeWatcher(document: vscode.TextDocument): ICodeWatcher {
        const newCodeWatcher = this.serviceContainer.get<ICodeWatcher>(ICodeWatcher);
        newCodeWatcher.setDocument(document);
        newCodeWatcher.codeLensUpdated(this.onWatcherUpdated.bind(this));
        this.activeCodeWatchers.push(newCodeWatcher);
        return newCodeWatcher;
    }

    private onWatcherUpdated(): void {
        this.didChangeCodeLenses.fire();
    }
}
