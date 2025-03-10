// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { expect } from 'chai';
import * as TypeMoq from 'typemoq';
import { ConfigurationTarget, Uri, WorkspaceConfiguration } from 'vscode';
import { IWorkspaceService } from '../../../platform/common/application/types';
import { JupyterSettings } from '../../../platform/common/configSettings.node';
import { ConfigurationService } from '../../../platform/common/configuration/service.node';
import { IExperimentService } from '../../../platform/common/types';
import { IServiceContainer } from '../../../platform/ioc/types';

suite('Configuration Service', () => {
    const resource = Uri.parse('a');
    let workspaceService: TypeMoq.IMock<IWorkspaceService>;
    let experimentService: TypeMoq.IMock<IExperimentService>;
    let serviceContainer: TypeMoq.IMock<IServiceContainer>;
    let configService: ConfigurationService;
    setup(() => {
        workspaceService = TypeMoq.Mock.ofType<IWorkspaceService>();
        workspaceService
            .setup((w) => w.getWorkspaceFolder(resource))
            .returns(() => ({
                uri: resource,
                index: 0,
                name: '0'
            }));
        serviceContainer = TypeMoq.Mock.ofType<IServiceContainer>();
        experimentService = TypeMoq.Mock.ofType<IExperimentService>();
        serviceContainer.setup((s) => s.get(IWorkspaceService)).returns(() => workspaceService.object);
        serviceContainer.setup((s) => s.get(IExperimentService)).returns(() => experimentService.object);
        configService = new ConfigurationService(serviceContainer.object);
    });

    function setupConfigProvider(): TypeMoq.IMock<WorkspaceConfiguration> {
        const workspaceConfig = TypeMoq.Mock.ofType<WorkspaceConfiguration>();
        workspaceService
            .setup((w) => w.getConfiguration(TypeMoq.It.isValue('jupyter'), TypeMoq.It.isValue(resource)))
            .returns(() => workspaceConfig.object);
        return workspaceConfig;
    }

    test('Fetching settings goes as expected', () => {
        const settings = configService.getSettings();
        expect(settings).to.be.instanceOf(JupyterSettings);
    });

    test('Do not update global settings if global value is already equal to the new value', async () => {
        const workspaceConfig = setupConfigProvider();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workspaceConfig.setup((w) => w.inspect('setting')).returns(() => ({ globalValue: 'globalValue' } as any));
        workspaceConfig
            .setup((w) => w.update('setting', 'globalValue', ConfigurationTarget.Global))
            .returns(() => Promise.resolve())
            .verifiable(TypeMoq.Times.never());

        await configService.updateSetting('setting', 'globalValue', resource, ConfigurationTarget.Global);

        workspaceConfig.verifyAll();
    });

    test('Update global settings if global value is not equal to the new value', async () => {
        const workspaceConfig = setupConfigProvider();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workspaceConfig.setup((w) => w.inspect('setting')).returns(() => ({ globalValue: 'globalValue' } as any));
        workspaceConfig
            .setup((w) => w.update('setting', 'newGlobalValue', ConfigurationTarget.Global))
            .returns(() => Promise.resolve())
            .verifiable(TypeMoq.Times.once());

        await configService.updateSetting('setting', 'newGlobalValue', resource, ConfigurationTarget.Global);

        workspaceConfig.verifyAll();
    });

    test('Do not update workspace settings if workspace value is already equal to the new value', async () => {
        const workspaceConfig = setupConfigProvider();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workspaceConfig.setup((w) => w.inspect('setting')).returns(() => ({ workspaceValue: 'workspaceValue' } as any));
        workspaceConfig
            .setup((w) => w.update('setting', 'workspaceValue', ConfigurationTarget.Workspace))
            .returns(() => Promise.resolve())
            .verifiable(TypeMoq.Times.never());

        await configService.updateSetting('setting', 'workspaceValue', resource, ConfigurationTarget.Workspace);

        workspaceConfig.verifyAll();
    });

    test('Update workspace settings if workspace value is not equal to the new value', async () => {
        const workspaceConfig = setupConfigProvider();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workspaceConfig.setup((w) => w.inspect('setting')).returns(() => ({ workspaceValue: 'workspaceValue' } as any));
        workspaceConfig
            .setup((w) => w.update('setting', 'newWorkspaceValue', ConfigurationTarget.Workspace))
            .returns(() => Promise.resolve())
            .verifiable(TypeMoq.Times.once());

        await configService.updateSetting('setting', 'newWorkspaceValue', resource, ConfigurationTarget.Workspace);

        workspaceConfig.verifyAll();
    });

    test('Do not update workspace folder settings if workspace folder value is already equal to the new value', async () => {
        const workspaceConfig = setupConfigProvider();
        workspaceConfig
            .setup((w) => w.inspect('setting'))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .returns(() => ({ workspaceFolderValue: 'workspaceFolderValue' } as any));
        workspaceConfig
            .setup((w) => w.update('setting', 'workspaceFolderValue', ConfigurationTarget.WorkspaceFolder))
            .returns(() => Promise.resolve())
            .verifiable(TypeMoq.Times.never());

        await configService.updateSetting(
            'setting',
            'workspaceFolderValue',
            resource,
            ConfigurationTarget.WorkspaceFolder
        );

        workspaceConfig.verifyAll();
    });

    test('Update workspace folder settings if workspace folder value is not equal to the new value', async () => {
        const workspaceConfig = setupConfigProvider();
        workspaceConfig
            .setup((w) => w.inspect('setting'))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .returns(() => ({ workspaceFolderValue: 'workspaceFolderValue' } as any));
        workspaceConfig
            .setup((w) => w.update('setting', 'newWorkspaceFolderValue', ConfigurationTarget.WorkspaceFolder))
            .returns(() => Promise.resolve())
            .verifiable(TypeMoq.Times.once());

        await configService.updateSetting(
            'setting',
            'newWorkspaceFolderValue',
            resource,
            ConfigurationTarget.WorkspaceFolder
        );

        workspaceConfig.verifyAll();
    });
});
