// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { assert } from 'chai';
import * as path from 'path';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { Uri } from 'vscode';
import { PYTHON_LANGUAGE } from '../../../platform/common/constants';
import { FileSystem } from '../../../platform/common/platform/fileSystem.node';
import { IFileSystem } from '../../../platform/common/platform/types.node';
import { IPythonExecutionFactory } from '../../../platform/common/process/types.node';
import { IKernel } from '../../../platform/../kernels/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts.node';
import { LocalWidgetScriptSourceProvider } from '../../../kernels/ipywidgets-message-coordination/localWidgetScriptSourceProvider.node';
import {
    ILocalResourceUriConverter,
    IWidgetScriptSourceProvider
} from '../../../kernels/ipywidgets-message-coordination/types';

/* eslint-disable , @typescript-eslint/no-explicit-any */
suite('DataScience - ipywidget - Local Widget Script Source', () => {
    let scriptSourceProvider: IWidgetScriptSourceProvider;
    let resourceConverter: ILocalResourceUriConverter;
    let fs: IFileSystem;
    let kernel: IKernel;
    let interpreterService: IInterpreterService;
    const filesToLookSearchFor = `*${path.sep}index.js`;
    function asVSCodeUri(uri: Uri) {
        return `vscodeUri://${uri.fsPath}`;
    }
    setup(() => {
        resourceConverter = mock<ILocalResourceUriConverter>();
        fs = mock(FileSystem);
        interpreterService = mock<IInterpreterService>();
        kernel = mock<IKernel>();
        when(resourceConverter.asWebviewUri(anything())).thenCall((uri) => Promise.resolve(asVSCodeUri(uri)));
        scriptSourceProvider = new LocalWidgetScriptSourceProvider(
            instance(kernel),
            instance(resourceConverter),
            instance(fs),
            instance(interpreterService),
            instance(mock<IPythonExecutionFactory>())
        );
    });
    test('No script source when there is no kernel associated with notebook', async () => {
        when(kernel.kernelConnectionMetadata).thenReturn();

        const value = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');

        assert.deepEqual(value, { moduleName: 'ModuleName' });
    });
    test('No script source when there are no widgets', async () => {
        when(kernel.kernelConnectionMetadata).thenReturn({
            kernelSpec: {
                name: '',
                path: '',
                display_name: '',
                argv: [],
                metadata: { interpreter: { sysPrefix: 'sysPrefix', path: 'pythonPath' } }
            },
            id: '',
            kind: 'startUsingLocalKernelSpec'
        });
        when(fs.searchLocal(anything(), anything())).thenResolve([]);

        const value = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');

        assert.deepEqual(value, { moduleName: 'ModuleName' });

        // Ensure we searched the directories.
        verify(fs.searchLocal(anything(), anything())).once();
    });
    test('Look for widgets in sysPath of interpreter defined in kernel metadata', async () => {
        const sysPrefix = 'sysPrefix Of Python in Metadata';
        const searchDirectory = path.join(sysPrefix, 'share', 'jupyter', 'nbextensions');

        when(kernel.kernelConnectionMetadata).thenReturn({
            kernelSpec: {
                name: '',
                path: '',
                display_name: '',
                argv: [],
                metadata: { interpreter: { sysPrefix, path: 'pythonPath' } }
            },
            id: '',
            kind: 'startUsingLocalKernelSpec'
        });
        when(fs.searchLocal(anything(), anything())).thenResolve([]);

        const value = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');

        assert.deepEqual(value, { moduleName: 'ModuleName' });

        // Ensure we look for the right things in the right place.
        verify(fs.searchLocal(filesToLookSearchFor, searchDirectory)).once();
    });
    test('Look for widgets in sysPath of kernel', async () => {
        const sysPrefix = 'sysPrefix Of Kernel';
        const kernelPath = 'kernel Path.exe';
        when(interpreterService.getInterpreterDetails(kernelPath)).thenResolve({ sysPrefix } as any);
        const searchDirectory = path.join(sysPrefix, 'share', 'jupyter', 'nbextensions');

        when(kernel.kernelConnectionMetadata).thenReturn({
            kernelSpec: { name: '', display_name: '', argv: [], path: kernelPath, language: PYTHON_LANGUAGE },
            id: '',
            kind: 'startUsingLocalKernelSpec'
        });
        when(fs.searchLocal(anything(), anything())).thenResolve([]);

        const value = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');

        assert.deepEqual(value, { moduleName: 'ModuleName' });

        // Ensure we look for the right things in the right place.
        verify(fs.searchLocal(filesToLookSearchFor, searchDirectory)).once();
    });
    test('Ensure we cache the list of widgets source (when nothing is found)', async () => {
        when(kernel.kernelConnectionMetadata).thenReturn({
            kernelSpec: {
                name: '',
                path: '',
                display_name: '',
                argv: [],
                metadata: { interpreter: { sysPrefix: 'sysPrefix', path: 'pythonPath' } }
            },
            id: '',
            kind: 'startUsingLocalKernelSpec'
        });
        when(fs.searchLocal(anything(), anything())).thenResolve([]);

        const value = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');
        assert.deepEqual(value, { moduleName: 'ModuleName' });
        const value1 = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');
        assert.deepEqual(value1, { moduleName: 'ModuleName' });
        const value2 = await scriptSourceProvider.getWidgetScriptSource('ModuleName', '1');
        assert.deepEqual(value2, { moduleName: 'ModuleName' });

        // Ensure we search directories once.
        verify(fs.searchLocal(anything(), anything())).once();
    });
    test('Ensure we search directory only once (cache results)', async () => {
        const sysPrefix = 'sysPrefix Of Python in Metadata';
        const searchDirectory = path.join(sysPrefix, 'share', 'jupyter', 'nbextensions');
        when(kernel.kernelConnectionMetadata).thenReturn({
            kernelSpec: {
                name: '',
                path: '',
                display_name: '',
                argv: [],
                metadata: { interpreter: { sysPrefix, path: 'pythonPath' } }
            },
            id: '',
            kind: 'startUsingLocalKernelSpec'
        });
        when(fs.searchLocal(anything(), anything())).thenResolve([
            // In order to match the real behavior, don't use join here
            'widget1/index.js',
            'widget2/index.js',
            'widget3/index.js'
        ]);

        const value = await scriptSourceProvider.getWidgetScriptSource('widget2', '1');
        assert.deepEqual(value, {
            moduleName: 'widget2',
            source: 'local',
            scriptUri: asVSCodeUri(Uri.file(path.join(searchDirectory, 'widget2', 'index.js')))
        });
        const value1 = await scriptSourceProvider.getWidgetScriptSource('widget2', '1');
        assert.deepEqual(value1, value);
        const value2 = await scriptSourceProvider.getWidgetScriptSource('widget2', '1');
        assert.deepEqual(value2, value);

        // Ensure we look for the right things in the right place.
        verify(fs.searchLocal(filesToLookSearchFor, searchDirectory)).once();
    });
    test('Get source for a specific widget & search in the right place', async () => {
        const sysPrefix = 'sysPrefix Of Python in Metadata';
        const searchDirectory = path.join(sysPrefix, 'share', 'jupyter', 'nbextensions');
        when(kernel.kernelConnectionMetadata).thenReturn({
            kernelSpec: {
                name: '',
                path: '',
                display_name: '',
                argv: [],
                metadata: { interpreter: { sysPrefix, path: 'pythonPath' } }
            },
            id: '',
            kind: 'startUsingLocalKernelSpec'
        });
        when(fs.searchLocal(anything(), anything())).thenResolve([
            // In order to match the real behavior, don't use join here
            'widget1/index.js',
            'widget2/index.js',
            'widget3/index.js'
        ]);

        const value = await scriptSourceProvider.getWidgetScriptSource('widget1', '1');

        // Ensure the script paths are properly converted to be used within notebooks.
        assert.deepEqual(value, {
            moduleName: 'widget1',
            source: 'local',
            scriptUri: asVSCodeUri(Uri.file(path.join(searchDirectory, 'widget1', 'index.js')))
        });

        // Ensure we look for the right things in the right place.
        verify(fs.searchLocal(filesToLookSearchFor, searchDirectory)).once();
    });
    test('Return empty source for widgets that cannot be found', async () => {
        const sysPrefix = 'sysPrefix Of Python in Metadata';
        const searchDirectory = path.join(sysPrefix, 'share', 'jupyter', 'nbextensions');
        when(kernel.kernelConnectionMetadata).thenReturn({
            kernelSpec: {
                name: '',
                path: '',
                display_name: '',
                argv: [],
                metadata: { interpreter: { sysPrefix, path: 'pythonPath' } }
            },
            id: '',
            kind: 'startUsingLocalKernelSpec'
        });
        when(fs.searchLocal(anything(), anything())).thenResolve([
            // In order to match the real behavior, don't use join here
            'widget1/index.js',
            'widget2/index.js',
            'widget3/index.js'
        ]);

        const value = await scriptSourceProvider.getWidgetScriptSource('widgetNotFound', '1');
        assert.deepEqual(value, {
            moduleName: 'widgetNotFound'
        });
        const value1 = await scriptSourceProvider.getWidgetScriptSource('widgetNotFound', '1');
        assert.isOk(value1);
        const value2 = await scriptSourceProvider.getWidgetScriptSource('widgetNotFound', '1');
        assert.deepEqual(value2, value1);
        // We should ignore version numbers (when getting widget sources from local fs).
        const value3 = await scriptSourceProvider.getWidgetScriptSource('widgetNotFound', '1234');
        assert.deepEqual(value3, value1);

        // Ensure we look for the right things in the right place.
        // Also ensure we call once (& cache for subsequent searches).
        verify(fs.searchLocal(filesToLookSearchFor, searchDirectory)).once();
    });
});
