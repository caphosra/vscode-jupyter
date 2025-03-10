// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { expect } from 'chai';
import { SemVer } from 'semver';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import * as typemoq from 'typemoq';
import { CancellationTokenSource, Disposable, EventEmitter } from 'vscode';
import { disposeAllDisposables } from '../../../platform/common/helpers.node';
import { IConfigurationService, IWatchableJupyterSettings } from '../../../platform/common/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts.node';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { NotebookServerProvider } from '../../../kernels/jupyter/launcher/notebookServerProvider.node';
import { JupyterServerUriStorage } from '../../../kernels/jupyter/launcher/serverUriStorage.node';
import { JupyterServerSelector } from '../../../kernels/jupyter/serverSelector.node';
import { DisplayOptions } from '../../../kernels/displayOptions.node';
import { IJupyterExecution, INotebookServer } from '../../../kernels/jupyter/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
function createTypeMoq<T>(tag: string): typemoq.IMock<T> {
    // Use typemoqs for those things that are resolved as promises. mockito doesn't allow nesting of mocks. ES6 Proxy class
    // is the problem. We still need to make it thenable though. See this issue: https://github.com/florinn/typemoq/issues/67
    const result = typemoq.Mock.ofType<T>();
    (result as any).tag = tag;
    result.setup((x: any) => x.then).returns(() => undefined);
    return result;
}

/* eslint-disable  */
suite('DataScience - NotebookServerProvider', () => {
    let serverProvider: NotebookServerProvider;
    let configurationService: IConfigurationService;
    let jupyterExecution: IJupyterExecution;
    let interpreterService: IInterpreterService;
    let pythonSettings: IWatchableJupyterSettings;
    const workingPython: PythonEnvironment = {
        path: '/foo/bar/python.exe',
        version: new SemVer('3.6.6-final'),
        sysVersion: '1.0.0.0',
        sysPrefix: 'Python'
    };
    const disposables: Disposable[] = [];
    let source: CancellationTokenSource;
    setup(() => {
        configurationService = mock<IConfigurationService>();
        jupyterExecution = mock<IJupyterExecution>();
        interpreterService = mock<IInterpreterService>();

        // Set up our settings
        pythonSettings = mock<IWatchableJupyterSettings>();
        when(pythonSettings.jupyterServerType).thenReturn('local');
        when(configurationService.getSettings(anything())).thenReturn(instance(pythonSettings));
        const serverStorage = mock(JupyterServerUriStorage);
        when(serverStorage.getUri()).thenResolve('local');
        const serverSelector = mock(JupyterServerSelector);
        const eventEmitter = new EventEmitter<void>();
        disposables.push(eventEmitter);
        when(serverStorage.onDidChangeUri).thenReturn(eventEmitter.event);
        when((jupyterExecution as any).then).thenReturn(undefined);
        when((serverSelector as any).then).thenReturn(undefined);
        when((serverStorage as any).then).thenReturn(undefined);

        // Create the server provider
        serverProvider = new NotebookServerProvider(
            instance(configurationService),
            instance(jupyterExecution),
            instance(interpreterService),
            instance(serverStorage),
            instance(serverSelector),
            disposables
        );
        source = new CancellationTokenSource();
        disposables.push(source);
    });
    teardown(() => disposeAllDisposables(disposables));
    test('NotebookServerProvider - Get Only - server', async () => {
        const notebookServer = mock<INotebookServer>();
        when((notebookServer as any).then).thenReturn(undefined);
        when(jupyterExecution.getServer(anything())).thenResolve(instance(notebookServer));

        const server = await serverProvider.getOrCreateServer({
            resource: undefined,
            ui: new DisplayOptions(false),
            token: source.token,
            localJupyter: true
        });
        expect(server).to.not.equal(undefined, 'Server expected to be defined');
        verify(jupyterExecution.getServer(anything())).once();
    });

    test('NotebookServerProvider - Get Or Create', async () => {
        when(jupyterExecution.getUsableJupyterPython()).thenResolve(workingPython);
        const notebookServer = createTypeMoq<INotebookServer>('jupyter server');
        when(jupyterExecution.connectToNotebookServer(anything(), anything())).thenResolve(notebookServer.object);

        // Disable UI just lets us skip mocking the progress reporter
        const server = await serverProvider.getOrCreateServer({
            ui: new DisplayOptions(true),
            resource: undefined,
            token: source.token,
            localJupyter: true
        });
        expect(server).to.not.equal(undefined, 'Server expected to be defined');
    });
});
