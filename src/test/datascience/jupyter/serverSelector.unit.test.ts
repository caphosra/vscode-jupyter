// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { assert } from 'chai';
import { anyString, anything, instance, mock, when } from 'ts-mockito';

import * as sinon from 'sinon';
import * as os from 'os';
import { QuickPickItem } from 'vscode';
import { ApplicationShell } from '../../../platform/common/application/applicationShell.node';
import { ClipboardService } from '../../../platform/common/application/clipboard.node';
import { IClipboard } from '../../../platform/common/application/types';
import { ConfigurationService } from '../../../platform/common/configuration/service.node';
import { IJupyterSettings } from '../../../platform/common/types';
import { DataScience } from '../../../platform/common/utils/localize';
import { MultiStepInput, MultiStepInputFactory } from '../../../platform/common/utils/multiStepInput.node';
import { MockInputBox } from '../mockInputBox';
import { MockQuickPick } from '../mockQuickPick';
import { MockMemento } from '../../mocks/mementos';
import { WorkspaceService } from '../../../platform/common/application/workspace';
import { CryptoUtils } from '../../../platform/common/crypto.node';
import { ApplicationEnvironment } from '../../../platform/common/application/applicationEnvironment.node';
import { MockEncryptedStorage } from '../mockEncryptedStorage';
import { JupyterServerUriStorage } from '../../../kernels/jupyter/launcher/serverUriStorage.node';
import { JupyterServerSelector } from '../../../kernels/jupyter/serverSelector.node';
import { JupyterUriProviderRegistration } from '../../../kernels/jupyter/jupyterUriProviderRegistration.node';
import { Settings } from '../../../platform/common/constants';

/* eslint-disable , @typescript-eslint/no-explicit-any */
suite('DataScience - Jupyter Server URI Selector', () => {
    let quickPick: MockQuickPick | undefined;
    let dsSettings: IJupyterSettings;
    let clipboard: IClipboard;
    let setting: string;

    function createDataScienceObject(
        quickPickSelection: string,
        inputSelection: string,
        hasFolders: boolean
    ): { selector: JupyterServerSelector; storage: JupyterServerUriStorage } {
        dsSettings = {
            jupyterServerType: Settings.JupyterServerLocalLaunch
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        clipboard = mock(ClipboardService);
        const configService = mock(ConfigurationService);
        const applicationShell = mock(ApplicationShell);
        const applicationEnv = mock(ApplicationEnvironment);
        const workspaceService = mock(WorkspaceService);
        const picker = mock(JupyterUriProviderRegistration);
        const crypto = mock(CryptoUtils);
        when(crypto.createHash(anyString(), 'string')).thenCall((a1, _a2) => a1);
        quickPick = new MockQuickPick(quickPickSelection);
        const input = new MockInputBox(inputSelection);
        when(applicationShell.createQuickPick()).thenReturn(quickPick!);
        when(applicationShell.createInputBox()).thenReturn(input);
        when(applicationEnv.machineId).thenReturn(os.hostname());
        const multiStepFactory = new MultiStepInputFactory(instance(applicationShell));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        when(configService.getSettings(anything())).thenReturn(dsSettings as any);
        when(configService.updateSetting(anything(), anything(), anything(), anything())).thenCall((_s, v) => {
            setting = v;
            return Promise.resolve();
        });
        when(workspaceService.getWorkspaceFolderIdentifier(anything())).thenReturn('1');
        when(workspaceService.hasWorkspaceFolders).thenReturn(hasFolders);
        const encryptedStorage = new MockEncryptedStorage();

        const storage = new JupyterServerUriStorage(
            instance(configService),
            instance(workspaceService),
            instance(crypto),
            encryptedStorage,
            instance(applicationEnv),
            new MockMemento()
        );
        const selector = new JupyterServerSelector(instance(clipboard), multiStepFactory, instance(picker), storage);
        return { selector, storage };
    }

    teardown(() => sinon.restore());

    test('Local pick server uri', async () => {
        const { selector, storage } = createDataScienceObject('$(zap) Default', '', true);
        await selector.selectJupyterURI(true);
        let value = await storage.getUri();
        assert.equal(value, Settings.JupyterServerLocalLaunch, 'Default should pick local launch');

        // Try a second time.
        await selector.selectJupyterURI(true);
        value = await storage.getUri();
        assert.equal(value, Settings.JupyterServerLocalLaunch, 'Default should pick local launch');

        // Verify active items
        assert.equal(quickPick?.items.length, 2, 'Wrong number of items in the quick pick');
    });

    test('Local pick server uri with no workspace', async () => {
        const { selector, storage } = createDataScienceObject('$(zap) Default', '', false);
        await selector.selectJupyterURI(true);
        let value = await storage.getUri();
        assert.equal(value, Settings.JupyterServerLocalLaunch, 'Default should pick local launch');

        // Try a second time.
        await selector.selectJupyterURI(true);
        value = await storage.getUri();
        assert.equal(value, Settings.JupyterServerLocalLaunch, 'Default should pick local launch');

        // Verify active items
        assert.equal(quickPick?.items.length, 2, 'Wrong number of items in the quick pick');
    });

    test('Quick pick MRU tests', async () => {
        const { selector, storage } = createDataScienceObject('$(zap) Default', '', true);
        console.log('Step1');
        await selector.selectJupyterURI(true);
        // Verify initial default items
        assert.equal(quickPick?.items.length, 2, 'Wrong number of items in the quick pick');

        // Add in a new server
        const serverA1 = { uri: 'ServerA', time: 1, date: new Date(1) };
        console.log('Step2');
        await storage.addToUriList(serverA1.uri, serverA1.time, serverA1.uri);

        console.log('Step3');
        await selector.selectJupyterURI(true);
        assert.equal(quickPick?.items.length, 3, 'Wrong number of items in the quick pick');
        quickPickCheck(quickPick?.items[2], serverA1);

        // Add in a second server, the newer server should be higher in the list due to newer time
        const serverB1 = { uri: 'ServerB', time: 2, date: new Date(2) };
        console.log('Step4');
        await storage.addToUriList(serverB1.uri, serverB1.time, serverB1.uri);
        console.log('Step5');
        await selector.selectJupyterURI(true);
        assert.equal(quickPick?.items.length, 4, 'Wrong number of items in the quick pick');
        quickPickCheck(quickPick?.items[2], serverB1);
        quickPickCheck(quickPick?.items[3], serverA1);

        // Reconnect to server A with a new time, it should now be higher in the list
        const serverA3 = { uri: 'ServerA', time: 3, date: new Date(3) };
        console.log('Step6');
        await storage.addToUriList(serverA3.uri, serverA3.time, serverA3.uri);
        console.log('Step7');
        await selector.selectJupyterURI(true);
        assert.equal(quickPick?.items.length, 4, 'Wrong number of items in the quick pick');
        quickPickCheck(quickPick?.items[3], serverB1);
        quickPickCheck(quickPick?.items[2], serverA1);

        // Verify that we stick to our settings limit
        for (let i = 0; i < Settings.JupyterServerUriListMax + 10; i = i + 1) {
            console.log(`Step8 ${i} of ${Settings.JupyterServerUriListMax + 10}`);
            await storage.addToUriList(i.toString(), i, i.toString());
        }

        console.log('Step9');
        await selector.selectJupyterURI(true);
        // Need a plus 2 here for the two default items
        assert.equal(
            quickPick?.items.length,
            Settings.JupyterServerUriListMax + 2,
            'Wrong number of items in the quick pick'
        );
    });

    function quickPickCheck(item: QuickPickItem | undefined, expected: { uri: string; time: Number; date: Date }) {
        assert.isOk(item, 'Quick pick item not defined');
        if (item) {
            assert.equal(item.label, expected.uri, 'Wrong URI value in quick pick');
            assert.equal(
                item.detail,
                DataScience.jupyterSelectURIMRUDetail().format(expected.date.toLocaleString()),
                'Wrong detail value in quick pick'
            );
        }
    }

    test('Remote server uri', async () => {
        const { selector, storage } = createDataScienceObject('$(server) Existing', 'http://localhost:1111', true);
        await selector.selectJupyterURI(true);
        const value = await storage.getUri();
        assert.equal(value, 'http://localhost:1111', 'Already running should end up with the user inputed value');
        assert.equal(setting, 'remote');
    });
    test('Remote server uri no workspace', async () => {
        const { selector, storage } = createDataScienceObject('$(server) Existing', 'http://localhost:1111', false);
        await selector.selectJupyterURI(true);
        const value = await storage.getUri();
        assert.equal(value, 'http://localhost:1111', 'Already running should end up with the user inputed value');
        assert.equal(setting, 'remote');
    });

    test('Remote server uri no local', async () => {
        const { selector, storage } = createDataScienceObject('$(server) Existing', 'http://localhost:1111', true);
        await selector.selectJupyterURI(false);
        const value = await storage.getUri();
        assert.equal(value, 'http://localhost:1111', 'Already running should end up with the user inputed value');
    });

    test('Remote server uri (reload VSCode if there is a change in settings)', async () => {
        const { selector, storage } = createDataScienceObject('$(server) Existing', 'http://localhost:1111', true);
        await selector.selectJupyterURI(true);
        const value = await storage.getUri();
        assert.equal(value, 'http://localhost:1111', 'Already running should end up with the user inputed value');
    });

    test('Remote server uri (do not reload VSCode if there is no change in settings)', async () => {
        const { selector, storage } = createDataScienceObject('$(server) Existing', 'http://localhost:1111', true);
        await storage.setUri('http://localhost:1111');

        await selector.selectJupyterURI(true);
        const value = await storage.getUri();
        assert.equal(value, 'http://localhost:1111', 'Already running should end up with the user inputed value');
    });

    test('Invalid server uri', async () => {
        const { selector, storage } = createDataScienceObject('$(server) Existing', 'httx://localhost:1111', true);
        await selector.selectJupyterURI(true);
        const value = await storage.getUri();
        assert.notEqual(value, 'httx://localhost:1111', 'Already running should validate');
        assert.equal(value, 'local', 'Validation failed');
    });

    suite('Default Uri when selecting remote uri', () => {
        const defaultUri = 'https://hostname:8080/?token=849d61a414abafab97bc4aab1f3547755ddc232c2b8cb7fe';

        async function testDefaultUri(expectedDefaultUri: string, clipboardValue?: string) {
            const showInputBox = sinon.spy(MultiStepInput.prototype, 'showInputBox');
            const { selector } = createDataScienceObject('$(server) Existing', 'http://localhost:1111', true);
            when(clipboard.readText()).thenResolve(clipboardValue || '');

            await selector.selectJupyterURI(true);

            assert.equal(showInputBox.firstCall.args[0].value, expectedDefaultUri);
        }

        test('Display default uri', async () => {
            await testDefaultUri(defaultUri);
        });
        test('Display default uri if clipboard is empty', async () => {
            await testDefaultUri(defaultUri, '');
        });
        test('Display default uri if clipboard contains invalid uri, display default uri', async () => {
            await testDefaultUri(defaultUri, 'Hello World!');
        });
        test('Display default uri if clipboard contains invalid file uri, display default uri', async () => {
            await testDefaultUri(defaultUri, 'file://test.pdf');
        });
        test('Display default uri if clipboard contains a valid uri, display uri from clipboard', async () => {
            const validUri = 'https://wow:0909/?password=1234';

            await testDefaultUri(validUri, validUri);
        });
    });
});
