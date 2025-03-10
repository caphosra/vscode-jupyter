// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { notebooks, NotebookCellExecutionStateChangeEvent, NotebookDocument, NotebookCellExecutionState } from 'vscode';
import { IExtensionSingleActivationService } from '../platform/activation/types';
import { IVSCodeNotebook } from '../platform/common/application/types';
import { IDisposableRegistry } from '../platform/common/types';
import { sendTelemetryEvent } from '../telemetry';
import { Telemetry } from '../webviews/webview-side/common/constants';
import { isJupyterNotebook } from './helpers.node';

/**
 * This class tracks opened notebooks & # of executed notebooks.
 */
@injectable()
export class NotebookUsageTracker implements IExtensionSingleActivationService {
    private readonly executedNotebooksIndexedByUri = new Set<string>();
    private openedNotebookCount: number = 0;
    constructor(
        @inject(IVSCodeNotebook) private readonly vscNotebook: IVSCodeNotebook,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public async activate(): Promise<void> {
        this.vscNotebook.onDidOpenNotebookDocument(this.onEditorOpened, this, this.disposables);
        this.vscNotebook.onDidChangeNotebookCellExecutionState(
            (e) => {
                if (isJupyterNotebook(e.cell.notebook) && e.state !== NotebookCellExecutionState.Idle) {
                    this.executedNotebooksIndexedByUri.add(e.cell.notebook.uri.fsPath);
                }
            },
            this,
            this.disposables
        );
        notebooks.onDidChangeNotebookCellExecutionState(
            this.onDidChangeNotebookCellExecutionState,
            this,
            this.disposables
        );
    }
    public dispose() {
        // Send a bunch of telemetry
        if (this.openedNotebookCount) {
            sendTelemetryEvent(Telemetry.NotebookOpenCount, undefined, { count: this.openedNotebookCount });
        }
        if (this.executedNotebooksIndexedByUri.size) {
            sendTelemetryEvent(Telemetry.NotebookRunCount, undefined, {
                count: this.executedNotebooksIndexedByUri.size
            });
        }
    }
    private onEditorOpened(doc: NotebookDocument): void {
        if (!isJupyterNotebook(doc)) {
            return;
        }
        this.openedNotebookCount += 1;
    }
    private onDidChangeNotebookCellExecutionState(e: NotebookCellExecutionStateChangeEvent): void {
        this.executedNotebooksIndexedByUri.add(e.cell.notebook.uri.fsPath);
    }
}
