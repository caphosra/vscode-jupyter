// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, NotebookCell, NotebookController, NotebookControllerAffinity, NotebookDocument } from 'vscode';
import { IPythonExtensionChecker } from '../../platform/api/types';
import { IVSCodeNotebook, ICommandManager, IApplicationShell } from '../../platform/common/application/types';
import { disposeAllDisposables } from '../../platform/common/helpers.node';
import { IDisposable, IDisposableRegistry } from '../../platform/common/types';
import { DataScience, Common } from '../../platform/common/utils/localize';
import { noop } from '../../platform/common/utils/misc';
import { sendTelemetryEvent } from '../../telemetry';
import {
    LanguagesSupportedByPythonkernel,
    Telemetry,
    PythonExtension
} from '../../webviews/webview-side/common/constants';
import { getNotebookMetadata, isPythonNotebook } from '../helpers.node';

export class NoPythonKernelsNotebookController implements Disposable {
    private readonly disposables: IDisposable[] = [];
    private readonly controller: NotebookController;
    constructor(
        viewType: string,
        private readonly notebookApi: IVSCodeNotebook,
        private readonly commandManager: ICommandManager,
        disposableRegistry: IDisposableRegistry,
        private readonly pythonExtensionChecker: IPythonExtensionChecker,
        private readonly appShell: IApplicationShell
    ) {
        disposableRegistry.push(this);
        this.controller = this.notebookApi.createNotebookController(
            `NoPythonController_${viewType}`,
            viewType,
            'Python 3',
            this.handleExecution.bind(this)
        );
        this.disposables.push(this.controller);
        this.controller.description = '';
        this.controller.detail = 'python3';
        this.controller.supportedLanguages = LanguagesSupportedByPythonkernel;
    }

    public dispose() {
        disposeAllDisposables(this.disposables);
    }

    public async updateNotebookAffinity(notebook: NotebookDocument, affinity: NotebookControllerAffinity) {
        this.controller.updateNotebookAffinity(notebook, affinity);
        this.updateLabels(notebook);
    }
    private updateLabels(document: NotebookDocument) {
        const metadata = getNotebookMetadata(document);
        if (!isPythonNotebook(metadata)) {
            return;
        }
        this.controller.label =
            metadata?.kernelspec?.display_name || metadata?.kernelspec?.name || this.controller.label;
    }
    private async handleExecution(_cells: NotebookCell[]) {
        if (this.pythonExtensionChecker.isPythonExtensionInstalled) {
            await this.handleExecutionWithoutPython();
        } else {
            await this.handleExecutionWithoutPythonExtension();
        }
    }
    private async handleExecutionWithoutPythonExtension() {
        sendTelemetryEvent(Telemetry.PythonExtensionNotInstalled, undefined, { action: 'displayed' });
        const selection = await this.appShell.showInformationMessage(
            DataScience.pythonExtensionRequiredToRunNotebook(),
            { modal: true },
            Common.install()
        );
        if (selection === Common.install()) {
            sendTelemetryEvent(Telemetry.PythonExtensionNotInstalled, undefined, { action: 'download' });
            this.commandManager.executeCommand('extension.open', PythonExtension).then(noop, noop);
        } else {
            sendTelemetryEvent(Telemetry.PythonExtensionNotInstalled, undefined, { action: 'dismissed' });
        }
    }
    private async handleExecutionWithoutPython() {
        sendTelemetryEvent(Telemetry.PythonNotInstalled, undefined, { action: 'displayed' });
        const selection = await this.appShell.showErrorMessage(
            DataScience.pythonNotInstalledNonMarkdown(),
            { modal: true },
            Common.install()
        );
        if (selection === Common.install()) {
            sendTelemetryEvent(Telemetry.PythonNotInstalled, undefined, { action: 'download' });
            this.appShell.openUrl('https://www.python.org/downloads');
        } else {
            sendTelemetryEvent(Telemetry.PythonNotInstalled, undefined, { action: 'dismissed' });
        }
    }
}
