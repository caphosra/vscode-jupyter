// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { ExtensionMode } from 'vscode';
import { IJupyterUriProvider, IJupyterUriProviderRegistration } from '../kernels/jupyter/types';
import { INotebookEditorProvider } from '../notebooks/types';
import { IDataViewerDataProvider, IDataViewerFactory } from '../webviews/extension-side/dataviewer/types';
import { IExportedKernelService } from './api/extension';
import { JupyterKernelServiceFactory } from './api/kernelApi.node';
import { IPythonApiProvider, PythonApi } from './api/types';
import { isTestExecution } from './common/constants';
import { IExtensionContext } from './common/types';
import { IServiceContainer, IServiceManager } from './ioc/types';
import { traceError } from './logging';

/*
 * Do not introduce any breaking changes to this API.
 * This is the public API for other extensions to interact with this extension.
 */

export interface IExtensionApi {
    /**
     * Promise indicating whether all parts of the extension have completed loading or not.
     * @type {Promise<void>}
     * @memberof IExtensionApi
     */
    ready: Promise<void>;
    /**
     * Launches Data Viewer component.
     * @param {IDataViewerDataProvider} dataProvider Instance that will be used by the Data Viewer component to fetch data.
     * @param {string} title Data Viewer title
     */
    showDataViewer(dataProvider: IDataViewerDataProvider, title: string): Promise<void>;
    /**
     * Registers a remote server provider component that's used to pick remote jupyter server URIs
     * @param serverProvider object called back when picking jupyter server URI
     */
    registerRemoteServerProvider(serverProvider: IJupyterUriProvider): void;
    registerPythonApi(pythonApi: PythonApi): void;
    /**
     * Creates a blank notebook and defaults the empty cell to the language provided.
     */
    createBlankNotebook(options: { defaultCellLanguage: string }): Promise<void>;
    /**
     * Gets the service that provides access to kernels.
     * Returns `undefined` if the calling extension is not allowed to access this API. This could
     * happen either when user doesn't allow this or the extension doesn't allow this.
     * There are a specific set of extensions that are currently allowed to access this API.
     */
    getKernelService(): Promise<IExportedKernelService | undefined>;
}

export function buildApi(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ready: Promise<any>,
    serviceManager: IServiceManager,
    serviceContainer: IServiceContainer,
    context: IExtensionContext
): IExtensionApi {
    let registered = false;
    const api: IExtensionApi = {
        // 'ready' will propagate the exception, but we must log it here first.
        ready: ready.catch((ex) => {
            traceError('Failure during activation.', ex);
            return Promise.reject(ex);
        }),
        registerPythonApi: (pythonApi: PythonApi) => {
            if (registered) {
                return;
            }
            registered = true;
            const apiProvider = serviceContainer.get<IPythonApiProvider>(IPythonApiProvider);
            apiProvider.setApi(pythonApi);
        },
        async showDataViewer(dataProvider: IDataViewerDataProvider, title: string): Promise<void> {
            const dataViewerProviderService = serviceContainer.get<IDataViewerFactory>(IDataViewerFactory);
            await dataViewerProviderService.create(dataProvider, title);
        },
        registerRemoteServerProvider(picker: IJupyterUriProvider): void {
            const container = serviceContainer.get<IJupyterUriProviderRegistration>(IJupyterUriProviderRegistration);
            container.registerProvider(picker);
        },
        createBlankNotebook: async (options: { defaultCellLanguage: string }): Promise<void> => {
            const service = serviceContainer.get<INotebookEditorProvider>(INotebookEditorProvider);
            await service.createNew(options);
        },
        getKernelService: async () => {
            const kernelServiceFactory = serviceContainer.get<JupyterKernelServiceFactory>(JupyterKernelServiceFactory);
            return kernelServiceFactory.getService();
        }
    };

    // In test/dev environment return the DI Container.
    if (
        isTestExecution() ||
        process.env.VSC_JUPYTER_EXPOSE_SVC ||
        context.extensionMode === ExtensionMode.Development
    ) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (api as any).serviceContainer = serviceContainer;
        (api as any).serviceManager = serviceManager;
        /* eslint-enable @typescript-eslint/no-explicit-any */
    }
    return api;
}
