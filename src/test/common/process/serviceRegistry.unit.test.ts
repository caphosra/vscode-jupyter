// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { instance, mock, verify } from 'ts-mockito';
import { BufferDecoder } from '../../../platform/common/process/decoder.node';
import { ProcessServiceFactory } from '../../../platform/common/process/processFactory.node';
import { PythonExecutionFactory } from '../../../platform/common/process/pythonExecutionFactory.node';
import { registerTypes } from '../../../platform/common/process/serviceRegistry.node';
import {
    IBufferDecoder,
    IProcessServiceFactory,
    IPythonExecutionFactory
} from '../../../platform/common/process/types.node';
import { ServiceManager } from '../../../platform/ioc/serviceManager.node';
import { IServiceManager } from '../../../platform/ioc/types';

suite('Common Process Service Registry', () => {
    let serviceManager: IServiceManager;

    setup(() => {
        serviceManager = mock(ServiceManager);
    });

    test('Ensure services are registered', async () => {
        registerTypes(instance(serviceManager));
        verify(serviceManager.addSingleton<IBufferDecoder>(IBufferDecoder, BufferDecoder)).once();
        verify(
            serviceManager.addSingleton<IProcessServiceFactory>(IProcessServiceFactory, ProcessServiceFactory)
        ).once();
        verify(
            serviceManager.addSingleton<IPythonExecutionFactory>(IPythonExecutionFactory, PythonExecutionFactory)
        ).once();
    });
});
