// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// eslint-disable-next-line @typescript-eslint/no-require-imports
import cloneDeep = require('lodash/cloneDeep');
import { INotebook, INotebookProviderConnection, IJupyterSession } from '../../types';

// This code is based on the examples here:
// https://www.npmjs.com/package/@jupyterlab/services

export class JupyterNotebook implements INotebook {
    private __connection: INotebookProviderConnection;
    constructor(public readonly session: IJupyterSession, connectionInfo: INotebookProviderConnection) {
        // Make a copy of the launch info so we can update it in this class
        this.__connection = cloneDeep(connectionInfo);
    }

    public get connection() {
        return this.__connection;
    }
}
