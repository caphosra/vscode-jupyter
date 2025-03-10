// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as path from 'path';
import { Uri } from 'vscode';
import { traceError } from '../../platform/logging';
import { IFileSystem } from '../../platform/common/platform/types.node';
import { IPythonExecutionFactory } from '../../platform/common/process/types.node';
import { IInterpreterService } from '../../platform/interpreter/contracts.node';
import { captureTelemetry } from '../../telemetry';
import { Telemetry } from '../../webviews/webview-side/common/constants';
import {
    getInterpreterFromKernelConnectionMetadata,
    isPythonKernelConnection,
    getKernelPathFromKernelConnection
} from '../helpers.node';
import { IKernel } from '../types';
import { ILocalResourceUriConverter, IWidgetScriptSourceProvider, WidgetScriptSource } from './types';

/**
 * Widget scripts are found in <python folder>/share/jupyter/nbextensions.
 * Here's an example:
 * <python folder>/share/jupyter/nbextensions/k3d/index.js
 * <python folder>/share/jupyter/nbextensions/nglview/index.js
 * <python folder>/share/jupyter/nbextensions/bqplot/index.js
 */
export class LocalWidgetScriptSourceProvider implements IWidgetScriptSourceProvider {
    private cachedWidgetScripts?: Promise<WidgetScriptSource[]>;
    constructor(
        private readonly kernel: IKernel,
        private readonly localResourceUriConverter: ILocalResourceUriConverter,
        private readonly fs: IFileSystem,
        private readonly interpreterService: IInterpreterService,
        private readonly factory: IPythonExecutionFactory
    ) {}
    public async getWidgetScriptSource(moduleName: string): Promise<Readonly<WidgetScriptSource>> {
        const sources = await this.getWidgetScriptSources();
        const found = sources.find((item) => item.moduleName.toLowerCase() === moduleName.toLowerCase());
        return found || { moduleName };
    }
    public dispose() {
        // Noop.
    }
    public async getWidgetScriptSources(ignoreCache?: boolean): Promise<Readonly<WidgetScriptSource[]>> {
        if (!ignoreCache && this.cachedWidgetScripts) {
            return this.cachedWidgetScripts;
        }
        return (this.cachedWidgetScripts = this.getWidgetScriptSourcesWithoutCache());
    }
    @captureTelemetry(Telemetry.DiscoverIPyWidgetNamesLocalPerf)
    private async getWidgetScriptSourcesWithoutCache(): Promise<WidgetScriptSource[]> {
        const sysPrefix = await this.getSysPrefixOfKernel();
        if (!sysPrefix) {
            return [];
        }

        const nbextensionsPath = path.join(sysPrefix, 'share', 'jupyter', 'nbextensions');
        // Search only one level deep, hence `*/index.js`.
        const files = await this.fs.searchLocal(`*${path.sep}index.js`, nbextensionsPath);

        const validFiles = files.filter((file) => {
            // Should be of the form `<widget module>/index.js`
            const parts = file.split('/'); // On windows this uses the unix separator too.
            if (parts.length !== 2) {
                traceError('Incorrect file found when searching for nnbextension entrypoints');
                return false;
            }
            return true;
        });

        const mappedFiles = validFiles.map(async (file) => {
            // Should be of the form `<widget module>/index.js`
            const parts = file.split('/');
            const moduleName = parts[0];

            const fileUri = Uri.file(path.join(nbextensionsPath, file));
            const scriptUri = (await this.localResourceUriConverter.asWebviewUri(fileUri)).toString();
            // eslint-disable-next-line
            const widgetScriptSource: WidgetScriptSource = { moduleName, scriptUri, source: 'local' };
            return widgetScriptSource;
        });
        return Promise.all(mappedFiles);
    }
    private async getSysPrefixOfKernel() {
        const kernelConnectionMetadata = this.kernel.kernelConnectionMetadata;
        if (!kernelConnectionMetadata) {
            return;
        }
        const interpreter = getInterpreterFromKernelConnectionMetadata(kernelConnectionMetadata);
        if (interpreter?.sysPrefix) {
            return interpreter?.sysPrefix;
        }
        if (!isPythonKernelConnection(kernelConnectionMetadata)) {
            return;
        }
        const interpreterOrKernelPath =
            interpreter?.path || getKernelPathFromKernelConnection(kernelConnectionMetadata);
        if (!interpreterOrKernelPath) {
            return;
        }
        const interpreterInfo = await this.interpreterService
            .getInterpreterDetails(interpreterOrKernelPath)
            .catch(
                traceError.bind(`Failed to get interpreter details for Kernel/Interpreter ${interpreterOrKernelPath}`)
            );

        if (interpreterInfo && !interpreterInfo.sysPrefix) {
            const pythonService = await this.factory.createActivatedEnvironment({ interpreter: interpreterInfo });
            const info = await pythonService.getInterpreterInformation();
            return info?.sysPrefix;
        }
        if (interpreterInfo) {
            return interpreterInfo?.sysPrefix;
        }
    }
}
