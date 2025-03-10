// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Uri } from 'vscode';
import { IDisposableRegistry, IExtensions, Resource } from '../platform/common/types';
import { PythonEnvironment } from '../platform/pythonEnvironments/info';
import { IExtensionSyncActivationService } from '../platform/activation/types';
import { IWorkspaceService } from '../platform/common/application/types';
import { inject, injectable } from 'inversify';
import { IInterpreterService } from '../platform/interpreter/contracts.node';
import { IPythonExtensionChecker } from '../platform/api/types';
import { areInterpreterPathsSame } from '../platform/pythonEnvironments/info/interpreter.node';

@injectable()
export class WorkspaceInterpreterTracker implements IExtensionSyncActivationService {
    private static readonly workspaceInterpreters = new Map<string, undefined | string>();
    private trackingInterpreters?: boolean;
    private static getWorkspaceIdentifier: (resource: Resource) => string = () => '';
    constructor(
        @inject(IExtensions) private readonly extensions: IExtensions,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(IPythonExtensionChecker) private readonly pythonExtensionChecker: IPythonExtensionChecker,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService
    ) {
        WorkspaceInterpreterTracker.getWorkspaceIdentifier = this.workspaceService.getWorkspaceFolderIdentifier.bind(
            this.workspaceService
        );
    }
    public activate() {
        this.trackActiveInterpreters();
        this.extensions.onDidChange(this.trackActiveInterpreters, this, this.disposables);
    }
    public static isActiveWorkspaceInterpreter(resource: Resource, interpreter?: PythonEnvironment) {
        if (!interpreter) {
            return;
        }
        const key = WorkspaceInterpreterTracker.getWorkspaceIdentifier(resource);
        const activeInterpreterPath = WorkspaceInterpreterTracker.workspaceInterpreters.get(key);
        if (!activeInterpreterPath) {
            return;
        }
        return areInterpreterPathsSame(activeInterpreterPath, interpreter.path);
    }
    private trackActiveInterpreters() {
        if (this.trackingInterpreters || !this.pythonExtensionChecker.isPythonExtensionActive) {
            return;
        }
        this.trackingInterpreters = true;
        this.interpreterService.onDidChangeInterpreter(
            async () => {
                const workspaces: Uri[] = Array.isArray(this.workspaceService.workspaceFolders)
                    ? this.workspaceService.workspaceFolders.map((item) => item.uri)
                    : [];
                await Promise.all(
                    workspaces.map(async (item) => {
                        try {
                            const workspaceId = this.workspaceService.getWorkspaceFolderIdentifier(item);
                            const interpreter = await this.interpreterService.getActiveInterpreter(item);
                            WorkspaceInterpreterTracker.workspaceInterpreters.set(workspaceId, interpreter?.path);
                        } catch (ex) {
                            // Don't care.
                        }
                    })
                );
            },
            this,
            this.disposables
        );
    }
}
