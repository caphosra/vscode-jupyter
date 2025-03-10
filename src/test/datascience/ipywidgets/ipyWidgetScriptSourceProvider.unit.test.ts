// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { ConfigurationChangeEvent, ConfigurationTarget, EventEmitter } from 'vscode';
import { ApplicationShell } from '../../../platform/common/application/applicationShell.node';
import { IApplicationShell, IWorkspaceService } from '../../../platform/common/application/types';
import { WorkspaceService } from '../../../platform/common/application/workspace';
import { ConfigurationService } from '../../../platform/common/configuration/service.node';
import { HttpClient } from '../../../platform/common/net/httpClient.node';
import { PersistentState, PersistentStateFactory } from '../../../platform/common/persistentState.node';
import { FileSystem } from '../../../platform/common/platform/fileSystem.node';
import { IPythonExecutionFactory } from '../../../platform/common/process/types.node';
import { IConfigurationService, IJupyterSettings } from '../../../platform/common/types';
import { Common, DataScience } from '../../../platform/common/utils/localize';
import { IKernel, RemoteKernelSpecConnectionMetadata } from '../../../platform/../kernels/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts.node';
import { CDNWidgetScriptSourceProvider } from '../../../kernels/ipywidgets-message-coordination/cdnWidgetScriptSourceProvider.node';
import { IPyWidgetScriptSourceProvider } from '../../../kernels/ipywidgets-message-coordination/ipyWidgetScriptSourceProvider.node';
import { LocalWidgetScriptSourceProvider } from '../../../kernels/ipywidgets-message-coordination/localWidgetScriptSourceProvider.node';
import { RemoteWidgetScriptSourceProvider } from '../../../kernels/ipywidgets-message-coordination/remoteWidgetScriptSourceProvider.node';
import { ILocalResourceUriConverter } from '../../../kernels/ipywidgets-message-coordination/types';

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */

suite('DataScience - ipywidget - Widget Script Source Provider', () => {
    let scriptSourceProvider: IPyWidgetScriptSourceProvider;
    let kernel: IKernel;
    let configService: IConfigurationService;
    let settings: IJupyterSettings;
    let appShell: IApplicationShell;
    let workspaceService: IWorkspaceService;
    let onDidChangeWorkspaceSettings: EventEmitter<ConfigurationChangeEvent>;
    let userSelectedOkOrDoNotShowAgainInPrompt: PersistentState<boolean>;
    setup(() => {
        configService = mock(ConfigurationService);
        appShell = mock(ApplicationShell);
        workspaceService = mock(WorkspaceService);
        onDidChangeWorkspaceSettings = new EventEmitter<ConfigurationChangeEvent>();
        when(workspaceService.onDidChangeConfiguration).thenReturn(onDidChangeWorkspaceSettings.event);
        const httpClient = mock(HttpClient);
        const resourceConverter = mock<ILocalResourceUriConverter>();
        const fs = mock(FileSystem);
        const interpreterService = mock<IInterpreterService>();
        const stateFactory = mock(PersistentStateFactory);
        const factory = mock<IPythonExecutionFactory>();
        userSelectedOkOrDoNotShowAgainInPrompt = mock<PersistentState<boolean>>();
        kernel = mock<IKernel>();
        when(stateFactory.createGlobalPersistentState(anything(), anything())).thenReturn(
            instance(userSelectedOkOrDoNotShowAgainInPrompt)
        );
        settings = { widgetScriptSources: [] } as any;
        when(configService.getSettings(anything())).thenReturn(settings as any);
        when(userSelectedOkOrDoNotShowAgainInPrompt.value).thenReturn(false);
        when(userSelectedOkOrDoNotShowAgainInPrompt.updateValue(anything())).thenResolve();
        scriptSourceProvider = new IPyWidgetScriptSourceProvider(
            instance(kernel),
            instance(resourceConverter),
            instance(fs),
            instance(interpreterService),
            instance(appShell),
            instance(configService),
            instance(workspaceService),
            instance(stateFactory),
            instance(httpClient),
            instance(factory)
        );
    });
    teardown(() => sinon.restore());

    [true, false].forEach((localLaunch) => {
        suite(localLaunch ? 'Local Jupyter Server' : 'Remote Jupyter Server', () => {
            setup(() => {
                if (!localLaunch) {
                    when(kernel.kernelConnectionMetadata).thenReturn(<RemoteKernelSpecConnectionMetadata>{
                        baseUrl: '',
                        id: '',
                        kernelSpec: {},
                        kind: 'startUsingRemoteKernelSpec'
                    });
                }
            });
            test('Prompt to use CDN', async () => {
                when(appShell.showInformationMessage(anything(), anything(), anything(), anything())).thenResolve();

                await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                verify(
                    appShell.showInformationMessage(
                        DataScience.useCDNForWidgets(),
                        Common.ok(),
                        Common.cancel(),
                        Common.doNotShowAgain()
                    )
                ).once();
            });
            test('Do  not prompt to use CDN if user has chosen not to use a CDN', async () => {
                when(appShell.showInformationMessage(anything(), anything(), anything(), anything())).thenResolve();
                when(userSelectedOkOrDoNotShowAgainInPrompt.value).thenReturn(true);

                await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                verify(
                    appShell.showInformationMessage(
                        DataScience.useCDNForWidgets(),
                        Common.ok(),
                        Common.cancel(),
                        Common.doNotShowAgain()
                    )
                ).never();
            });
            function verifyNoCDNUpdatedInSettings() {
                // Confirm message was displayed.
                verify(
                    appShell.showInformationMessage(
                        DataScience.useCDNForWidgets(),
                        Common.ok(),
                        Common.cancel(),
                        Common.doNotShowAgain()
                    )
                ).once();

                // Confirm settings were updated.
                verify(
                    configService.updateSetting(
                        'widgetScriptSources',
                        deepEqual([]),
                        undefined,
                        ConfigurationTarget.Global
                    )
                ).once();
            }
            test('Do not update if prompt is dismissed', async () => {
                when(appShell.showInformationMessage(anything(), anything(), anything(), anything())).thenResolve();

                await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                verify(configService.updateSetting(anything(), anything(), anything(), anything())).never();
                verify(userSelectedOkOrDoNotShowAgainInPrompt.updateValue(true)).never();
            });
            test('Do not update settings if Cancel is clicked in prompt', async () => {
                when(appShell.showInformationMessage(anything(), anything(), anything(), anything())).thenResolve(
                    Common.cancel() as any
                );

                await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                verify(configService.updateSetting(anything(), anything(), anything(), anything())).never();
                verify(userSelectedOkOrDoNotShowAgainInPrompt.updateValue(true)).never();
            });
            test('Update settings to not use CDN if `Do Not Show Again` is clicked in prompt', async () => {
                when(appShell.showInformationMessage(anything(), anything(), anything(), anything())).thenResolve(
                    Common.doNotShowAgain() as any
                );

                await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                verifyNoCDNUpdatedInSettings();
                verify(userSelectedOkOrDoNotShowAgainInPrompt.updateValue(true)).once();
            });
            test('Update settings to use CDN based on prompt', async () => {
                when(appShell.showInformationMessage(anything(), anything(), anything(), anything())).thenResolve(
                    Common.ok() as any
                );

                await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                // Confirm message was displayed.
                verify(
                    appShell.showInformationMessage(
                        DataScience.useCDNForWidgets(),
                        Common.ok(),
                        Common.cancel(),
                        Common.doNotShowAgain()
                    )
                ).once();
                // Confirm settings were updated.
                verify(userSelectedOkOrDoNotShowAgainInPrompt.updateValue(true)).once();
                verify(
                    configService.updateSetting(
                        'widgetScriptSources',
                        deepEqual(['jsdelivr.com', 'unpkg.com']),
                        undefined,
                        ConfigurationTarget.Global
                    )
                ).once();
            });
            test('Attempt to get widget source from all providers', async () => {
                (<any>settings).widgetScriptSources = ['jsdelivr.com', 'unpkg.com'];
                const localOrRemoteSource = localLaunch
                    ? sinon.stub(LocalWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource')
                    : sinon.stub(RemoteWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');
                const cdnSource = sinon.stub(CDNWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');

                localOrRemoteSource.resolves({ moduleName: 'HelloWorld' });
                cdnSource.resolves({ moduleName: 'HelloWorld' });

                scriptSourceProvider.initialize();
                const value = await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                assert.deepEqual(value, { moduleName: 'HelloWorld' });
                assert.isTrue(localOrRemoteSource.calledOnce);
                assert.isTrue(cdnSource.calledOnce);
            });
            test('Widget sources should respect changes to configuration settings', async () => {
                // 1. Search CDN then local/remote juptyer.
                (<any>settings).widgetScriptSources = ['jsdelivr.com', 'unpkg.com'];
                const localOrRemoteSource = localLaunch
                    ? sinon.stub(LocalWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource')
                    : sinon.stub(RemoteWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');
                const cdnSource = sinon.stub(CDNWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');
                cdnSource.resolves({ moduleName: 'moduleCDN', scriptUri: '1', source: 'cdn' });

                scriptSourceProvider.initialize();
                let values = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '`');

                assert.deepEqual(values, { moduleName: 'moduleCDN', scriptUri: '1', source: 'cdn' });
                assert.isFalse(localOrRemoteSource.calledOnce);
                assert.isTrue(cdnSource.calledOnce);

                // 2. Update settings to remove the use of CDNs
                localOrRemoteSource.reset();
                cdnSource.reset();
                localOrRemoteSource.resolves({ moduleName: 'moduleLocal', scriptUri: '1', source: 'local' });
                (<any>settings).widgetScriptSources = [];
                onDidChangeWorkspaceSettings.fire({ affectsConfiguration: () => true });

                values = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '`');
                assert.deepEqual(values, { moduleName: 'moduleLocal', scriptUri: '1', source: 'local' });
                assert.isTrue(localOrRemoteSource.calledOnce);
                assert.isFalse(cdnSource.calledOnce);
            });
            test('Widget source should support fall back search', async () => {
                // 1. Search CDN and if that fails then get from local/remote.
                (<any>settings).widgetScriptSources = ['jsdelivr.com', 'unpkg.com'];
                const localOrRemoteSource = localLaunch
                    ? sinon.stub(LocalWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource')
                    : sinon.stub(RemoteWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');
                const cdnSource = sinon.stub(CDNWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');
                localOrRemoteSource.resolves({ moduleName: 'moduleLocal', scriptUri: '1', source: 'local' });
                cdnSource.resolves({ moduleName: 'moduleCDN' });

                scriptSourceProvider.initialize();
                const value = await scriptSourceProvider.getWidgetScriptSource('', '');

                // 1. Confirm CDN was first searched, then local/remote
                assert.deepEqual(value, { moduleName: 'moduleLocal', scriptUri: '1', source: 'local' });
                assert.isTrue(localOrRemoteSource.calledOnce);
                assert.isTrue(cdnSource.calledOnce);
                // Confirm we first searched CDN before going to local/remote.
                cdnSource.calledBefore(localOrRemoteSource);
            });
            test('Widget sources from CDN should be given preference', async () => {
                (<any>settings).widgetScriptSources = ['jsdelivr.com', 'unpkg.com'];
                const localOrRemoteSource = localLaunch
                    ? sinon.stub(LocalWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource')
                    : sinon.stub(RemoteWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');
                const cdnSource = sinon.stub(CDNWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');

                localOrRemoteSource.resolves({ moduleName: 'module1' });
                cdnSource.resolves({ moduleName: 'module1', scriptUri: '1', source: 'cdn' });

                scriptSourceProvider.initialize();
                const values = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');

                assert.deepEqual(values, { moduleName: 'module1', scriptUri: '1', source: 'cdn' });
                assert.isFalse(localOrRemoteSource.calledOnce);
                assert.isTrue(cdnSource.calledOnce);
                verify(appShell.showWarningMessage(anything(), anything(), anything(), anything())).never();
            });
            test('When CDN is turned on and widget script is not found, then display a warning about script not found on CDN', async () => {
                (<any>settings).widgetScriptSources = ['jsdelivr.com', 'unpkg.com'];
                const localOrRemoteSource = localLaunch
                    ? sinon.stub(LocalWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource')
                    : sinon.stub(RemoteWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');
                const cdnSource = sinon.stub(CDNWidgetScriptSourceProvider.prototype, 'getWidgetScriptSource');

                localOrRemoteSource.resolves({ moduleName: 'module1' });
                cdnSource.resolves({ moduleName: 'module1' });

                scriptSourceProvider.initialize();
                let values = await scriptSourceProvider.getWidgetScriptSource('module1', '1');

                assert.deepEqual(values, { moduleName: 'module1' });
                assert.isTrue(localOrRemoteSource.calledOnce);
                assert.isTrue(cdnSource.calledOnce);
                const expectedMessage = DataScience.widgetScriptNotFoundOnCDNWidgetMightNotWork().format(
                    'module1',
                    '1',
                    JSON.stringify((<any>settings).widgetScriptSources)
                );
                verify(appShell.showWarningMessage(expectedMessage, anything(), anything(), anything())).once();

                // Ensure message is not displayed more than once.
                values = await scriptSourceProvider.getWidgetScriptSource('module1', '1');

                assert.deepEqual(values, { moduleName: 'module1' });
                assert.isTrue(localOrRemoteSource.calledTwice);
                assert.isTrue(cdnSource.calledTwice);
                verify(appShell.showWarningMessage(expectedMessage, anything(), anything(), anything())).once();
            });
        });
    });
});
