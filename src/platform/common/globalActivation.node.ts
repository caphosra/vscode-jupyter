// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import type { JSONObject } from '@lumino/coreutils';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { ICommandManager, IDocumentManager, IWorkspaceService } from './application/types';
import { PYTHON_FILE, PYTHON_LANGUAGE, PYTHON_UNTITLED } from './constants';
import { ContextKey } from './contextKey.node';
import './extensions';
import { IConfigurationService, IDisposable, IDisposableRegistry, IExtensionContext } from './types';
import { debounceAsync, swallowExceptions } from './utils/decorators';
import { noop } from './utils/misc';
import { sendTelemetryEvent } from '../../telemetry';
import { CommandRegistry } from '../../interactive-window/commands/commandRegistry.node';
import { CommandRegistry as PlatformCommandRegistry } from '../commands/commandRegistry.node';
import { EditorContexts, Telemetry } from './constants';
import { IExtensionSingleActivationService } from '../activation/types';
import { IDataScienceCodeLensProvider } from '../../interactive-window/editor-integration/types';
import { IRawNotebookSupportedService } from '../../kernels/raw/types';
import { hasCells } from '../../interactive-window/editor-integration/cellFactory.node';

@injectable()
export class GlobalActivation implements IExtensionSingleActivationService {
    public isDisposed: boolean = false;
    private changeHandler: IDisposable | undefined;
    private startTime: number = Date.now();
    constructor(
        @inject(ICommandManager) private commandManager: ICommandManager,
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(IExtensionContext) private extensionContext: IExtensionContext,
        @inject(IDataScienceCodeLensProvider) private dataScienceCodeLensProvider: IDataScienceCodeLensProvider,
        @inject(IConfigurationService) private configuration: IConfigurationService,
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(IWorkspaceService) private workspace: IWorkspaceService,
        @inject(CommandRegistry) private commandRegistry: CommandRegistry,
        @inject(PlatformCommandRegistry) private platformCommandRegistry: PlatformCommandRegistry,
        @inject(IRawNotebookSupportedService) private rawSupported: IRawNotebookSupportedService
    ) {
        this.disposableRegistry.push(this.commandRegistry);
        this.disposableRegistry.push(this.platformCommandRegistry);
    }

    public get activationStartTime(): number {
        return this.startTime;
    }

    public async activate(): Promise<void> {
        this.commandRegistry.register();
        this.platformCommandRegistry.register();

        this.extensionContext.subscriptions.push(
            vscode.languages.registerCodeLensProvider([PYTHON_FILE, PYTHON_UNTITLED], this.dataScienceCodeLensProvider)
        );

        // Set our initial settings and sign up for changes
        this.onSettingsChanged();
        this.changeHandler = this.configuration.getSettings(undefined).onDidChange(this.onSettingsChanged.bind(this));
        this.disposableRegistry.push(this);

        // Listen for active editor changes so we can detect have code cells or not
        this.disposableRegistry.push(
            this.documentManager.onDidChangeActiveTextEditor(() => this.onChangedActiveTextEditor())
        );
        this.onChangedActiveTextEditor();

        // Send telemetry for all of our settings
        this.sendSettingsTelemetry().ignoreErrors();

        // Figure out the ZMQ available context key
        this.computeZmqAvailable();
    }

    public async dispose() {
        if (this.changeHandler) {
            this.changeHandler.dispose();
            this.changeHandler = undefined;
        }
    }

    private onSettingsChanged = () => {
        const settings = this.configuration.getSettings(undefined);
        const ownsSelection = settings.sendSelectionToInteractiveWindow;
        const editorContext = new ContextKey(EditorContexts.OwnsSelection, this.commandManager);
        void editorContext.set(ownsSelection).catch(noop);
    };

    private computeZmqAvailable() {
        const zmqContext = new ContextKey(EditorContexts.ZmqAvailable, this.commandManager);
        void zmqContext.set(this.rawSupported.isSupported);
    }

    private onChangedActiveTextEditor() {
        // Setup the editor context for the cells
        const editorContext = new ContextKey(EditorContexts.HasCodeCells, this.commandManager);
        const activeEditor = this.documentManager.activeTextEditor;

        if (activeEditor && activeEditor.document.languageId === PYTHON_LANGUAGE) {
            // Inform the editor context that we have cells, fire and forget is ok on the promise here
            // as we don't care to wait for this context to be set and we can't do anything if it fails
            void editorContext.set(hasCells(activeEditor.document, this.configuration.getSettings())).catch(noop);
        } else {
            void editorContext.set(false).catch(noop);
        }
    }

    @debounceAsync(1)
    @swallowExceptions('Sending DataScience Settings Telemetry failed')
    private async sendSettingsTelemetry(): Promise<void> {
        // Get our current settings. This is what we want to send.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settings = this.configuration.getSettings() as any;

        // Translate all of the 'string' based settings into known values or not.
        const pythonConfig = this.workspace.getConfiguration('jupyter');
        if (pythonConfig) {
            const keys = Object.keys(settings);
            const resultSettings: JSONObject = {};
            for (const k of keys) {
                const currentValue = settings[k];
                if (typeof currentValue === 'string' && k !== 'interactiveWindowMode') {
                    const inspectResult = pythonConfig.inspect<string>(`${k}`);
                    if (inspectResult && inspectResult.defaultValue !== currentValue) {
                        resultSettings[k] = 'non-default';
                    } else {
                        resultSettings[k] = 'default';
                    }
                } else {
                    resultSettings[k] = currentValue;
                }
            }
            sendTelemetryEvent(Telemetry.DataScienceSettings, 0, resultSettings);
        }
    }
}
