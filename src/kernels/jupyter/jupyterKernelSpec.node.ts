// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import type { KernelSpec } from '@jupyterlab/services';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IJupyterKernelSpec } from '../types';

export class JupyterKernelSpec implements IJupyterKernelSpec {
    public name: string;
    public originalName?: string;
    public language: string;
    public path: string;
    public readonly env: NodeJS.ProcessEnv | undefined;
    public display_name: string;
    public argv: string[];
    public interrupt_mode?: 'message' | 'signal';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public metadata?: Record<string, any> & { interpreter?: Partial<PythonEnvironment> };
    constructor(
        specModel: KernelSpec.ISpecModel,
        public readonly specFile?: string,
        public readonly interpreterPath?: string,
        public readonly isRegisteredByVSC?:
            | 'registeredByNewVersionOfExt'
            | 'registeredByOldVersionOfExt'
            | 'registeredByNewVersionOfExtForCustomKernelSpec'
    ) {
        this.name = specModel.name;
        this.argv = specModel.argv;
        this.language = specModel.language;
        this.path = specModel.argv && specModel.argv.length > 0 ? specModel.argv[0] : '';
        this.display_name = specModel.display_name;
        this.metadata = specModel.metadata;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.env = specModel.env as any; // JSONObject, but should match
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.interrupt_mode = specModel.interrupt_mode as any;
    }
}
