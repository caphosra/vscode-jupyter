// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { IExtensionSingleActivationService } from '../platform/activation/types';
import { IServiceManager } from '../platform/ioc/types';
import { PythonKernelCompletionProvider } from './pythonKernelCompletionProvider.node';
import { PythonKernelCompletionProviderRegistration } from './pythonKernelCompletionProviderRegistration.node';

export function registerTypes(serviceManager: IServiceManager, _isDevMode: boolean) {
    serviceManager.addSingleton<PythonKernelCompletionProvider>(
        PythonKernelCompletionProvider,
        PythonKernelCompletionProvider
    ); // Used in tests
    serviceManager.addSingleton<IExtensionSingleActivationService>(
        IExtensionSingleActivationService,
        PythonKernelCompletionProviderRegistration
    );
}
