// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { expect } from 'chai';
import { instance, mock, verify, when } from 'ts-mockito';
import { Disposable, Uri } from 'vscode';
import { IWorkspaceService } from '../../../platform/common/application/types';

import { BufferDecoder } from '../../../platform/common/process/decoder.node';
import { ProcessLogger } from '../../../platform/common/process/logger.node';
import { ProcessService } from '../../../platform/common/process/proc.node';
import { ProcessServiceFactory } from '../../../platform/common/process/processFactory.node';
import { IBufferDecoder, IProcessLogger } from '../../../platform/common/process/types.node';
import { IDisposableRegistry } from '../../../platform/common/types';
import { EnvironmentVariablesProvider } from '../../../platform/common/variables/environmentVariablesProvider.node';
import { IEnvironmentVariablesProvider } from '../../../platform/common/variables/types';

suite('Process - ProcessServiceFactory', () => {
    let factory: ProcessServiceFactory;
    let envVariablesProvider: IEnvironmentVariablesProvider;
    let bufferDecoder: IBufferDecoder;
    let processLogger: IProcessLogger;
    let processService: ProcessService;
    let disposableRegistry: IDisposableRegistry;

    setup(() => {
        bufferDecoder = mock(BufferDecoder);
        envVariablesProvider = mock(EnvironmentVariablesProvider);
        processLogger = mock(ProcessLogger);
        when(processLogger.logProcess('', [], {})).thenReturn();
        processService = mock(ProcessService);
        when(
            processService.on('exec', () => {
                return;
            })
        ).thenReturn(processService);
        disposableRegistry = [];
        const workspace = mock<IWorkspaceService>();
        when(workspace.isTrusted).thenReturn(true);
        factory = new ProcessServiceFactory(
            instance(envVariablesProvider),
            instance(processLogger),
            instance(bufferDecoder),
            disposableRegistry,
            instance(workspace)
        );
    });

    teardown(() => {
        (disposableRegistry as Disposable[]).forEach((d) => d.dispose());
    });

    [Uri.parse('test'), undefined].forEach((resource) => {
        test(`Ensure ProcessService is created with an ${resource ? 'existing' : 'undefined'} resource`, async () => {
            when(envVariablesProvider.getEnvironmentVariables(resource)).thenResolve({ x: 'test' });

            const proc = await factory.create(resource);
            verify(envVariablesProvider.getEnvironmentVariables(resource)).once();

            const disposables = disposableRegistry as Disposable[];
            expect(disposables.length).equal(1);
            expect(proc).instanceOf(ProcessService);
        });
    });
});
