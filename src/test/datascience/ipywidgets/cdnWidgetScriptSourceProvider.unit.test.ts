// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { assert } from 'chai';
import * as fs from 'fs-extra';
import { sha256 } from 'hash.js';
import * as nock from 'nock';
import * as path from 'path';
import { Readable } from 'stream';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';
import { JupyterSettings } from '../../../platform/common/configSettings.node';
import { ConfigurationService } from '../../../platform/common/configuration/service.node';
import { FileSystem } from '../../../platform/common/platform/fileSystem.node';
import { IFileSystem } from '../../../platform/common/platform/types.node';
import { IConfigurationService, WidgetCDNs } from '../../../platform/common/types';
import { noop } from '../../../platform/common/utils/misc';
import { EXTENSION_ROOT_DIR } from '../../../platform/constants.node';
import { CDNWidgetScriptSourceProvider } from '../../../kernels/ipywidgets-message-coordination/cdnWidgetScriptSourceProvider.node';
import { IPyWidgetScriptSource } from '../../../kernels/ipywidgets-message-coordination/ipyWidgetScriptSource.node';
import {
    ILocalResourceUriConverter,
    IWidgetScriptSourceProvider
} from '../../../kernels/ipywidgets-message-coordination/types';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, , @typescript-eslint/no-explicit-any, , no-console */
const sanitize = require('sanitize-filename');

const unpgkUrl = 'https://unpkg.com/';
const jsdelivrUrl = 'https://cdn.jsdelivr.net/npm/';

/* eslint-disable , @typescript-eslint/no-explicit-any */
suite('DataScience - ipywidget - CDN', () => {
    let scriptSourceProvider: IWidgetScriptSourceProvider;
    let configService: IConfigurationService;
    let settings: JupyterSettings;
    let fileSystem: IFileSystem;
    let webviewUriConverter: ILocalResourceUriConverter;
    let tempFileCount = 0;
    suiteSetup(function () {
        // Nock seems to fail randomly on CI builds. See bug
        // https://github.com/microsoft/vscode-python/issues/11442
        // eslint-disable-next-line no-invalid-this
        return this.skip();
    });
    setup(() => {
        configService = mock(ConfigurationService);
        fileSystem = mock(FileSystem);
        webviewUriConverter = mock(IPyWidgetScriptSource);
        settings = { widgetScriptSources: [] } as any;
        when(configService.getSettings(anything())).thenReturn(settings as any);
        when(fileSystem.localFileExists(anything())).thenCall((f) => fs.pathExists(f));

        when(fileSystem.createTemporaryLocalFile(anything())).thenCall(createTemporaryFile);
        when(fileSystem.createLocalWriteStream(anything())).thenCall((p) => fs.createWriteStream(p));
        when(fileSystem.createDirectory(anything())).thenCall((d) => fs.ensureDir(d));
        when(webviewUriConverter.rootScriptFolder).thenReturn(
            Uri.file(path.join(EXTENSION_ROOT_DIR, 'tmp', 'scripts'))
        );
        when(webviewUriConverter.asWebviewUri(anything())).thenCall((u) => u);
        scriptSourceProvider = new CDNWidgetScriptSourceProvider(
            instance(configService),
            instance(webviewUriConverter),
            instance(fileSystem)
        );
    });

    teardown(() => {
        clearDiskCache();
    });

    function createStreamFromString(str: string) {
        const readable = new Readable();
        readable._read = noop;
        readable.push(str);
        readable.push(null);
        return readable;
    }

    function createTemporaryFile(ext: string) {
        tempFileCount += 1;

        // Put temp files next to extension so we can clean them up later
        const filePath = path.join(
            EXTENSION_ROOT_DIR,
            'tmp',
            'tempfile_loc',
            `tempfile_for_test${tempFileCount}.${ext}`
        );
        fs.createFileSync(filePath);
        return {
            filePath,
            dispose: () => {
                fs.removeSync(filePath);
            }
        };
    }

    function generateScriptName(moduleName: string, moduleVersion: string) {
        const hash = sanitize(sha256().update(`${moduleName}${moduleVersion}`).digest('hex'));
        return Uri.file(path.join(EXTENSION_ROOT_DIR, 'tmp', 'scripts', hash, 'index.js')).toString();
    }

    function clearDiskCache() {
        try {
            fs.removeSync(path.join(EXTENSION_ROOT_DIR, 'tmp', 'scripts'));
            fs.removeSync(path.join(EXTENSION_ROOT_DIR, 'tmp', 'tempfile_loc'));
        } catch {
            // Swallow any errors here
        }
    }

    [true, false].forEach((localLaunch) => {
        suite(localLaunch ? 'Local Jupyter Server' : 'Remote Jupyter Server', () => {
            test('Script source will be empty if CDN is not a configured source of widget scripts in settings', async () => {
                const value = await scriptSourceProvider.getWidgetScriptSource('HelloWorld', '1');

                assert.deepEqual(value, { moduleName: 'HelloWorld' });
                // Should not make any http calls.
                // verify(httpClient.exists(anything())).never();
            });
            function updateCDNSettings(...values: WidgetCDNs[]) {
                settings.widgetScriptSources = values;
            }
            (['unpkg.com', 'jsdelivr.com'] as WidgetCDNs[]).forEach((cdn) => {
                suite(cdn, () => {
                    const moduleName = 'HelloWorld';
                    const moduleVersion = '1';
                    let baseUrl = '';
                    let scriptUri = '';
                    setup(() => {
                        baseUrl = cdn === 'unpkg.com' ? unpgkUrl : jsdelivrUrl;
                        scriptUri = generateScriptName(moduleName, moduleVersion);
                    });
                    teardown(() => {
                        clearDiskCache();
                        scriptSourceProvider.dispose();
                        nock.cleanAll();
                    });
                    test('Ensure widget script is downloaded once and cached', async () => {
                        updateCDNSettings(cdn);
                        let downloadCount = 0;
                        nock(baseUrl)
                            .log(console.log)

                            .get(/.*/)
                            .reply(200, () => {
                                downloadCount += 1;
                                return createStreamFromString('foo');
                            });

                        const value = await scriptSourceProvider.getWidgetScriptSource(moduleName, moduleVersion);

                        assert.deepEqual(value, {
                            moduleName: 'HelloWorld',
                            scriptUri,
                            source: 'cdn'
                        });

                        const value2 = await scriptSourceProvider.getWidgetScriptSource(moduleName, moduleVersion);

                        assert.deepEqual(value2, {
                            moduleName: 'HelloWorld',
                            scriptUri,
                            source: 'cdn'
                        });

                        assert.equal(downloadCount, 1, 'Downloaded more than once');
                    });
                    test('No script source if package does not exist on CDN', async () => {
                        updateCDNSettings(cdn);
                        nock(baseUrl).log(console.log).get(/.*/).replyWithError('404');

                        const value = await scriptSourceProvider.getWidgetScriptSource(moduleName, moduleVersion);

                        assert.deepEqual(value, {
                            moduleName: 'HelloWorld'
                        });
                    });
                    test('Script source if package does not exist on both CDNs', async () => {
                        // Add the other cdn (the opposite of the working one)
                        const cdns =
                            cdn === 'unpkg.com'
                                ? ([cdn, 'jsdelivr.com'] as WidgetCDNs[])
                                : ([cdn, 'unpkg.com'] as WidgetCDNs[]);
                        updateCDNSettings(cdns[0], cdns[1]);
                        // Make only one cdn available
                        // when(httpClient.exists(anything())).thenCall((a) => {
                        //     if (a.includes(cdn[0])) {
                        //         return true;
                        //     }
                        //     return false;
                        // });
                        nock(baseUrl)
                            .get(/.*/)
                            .reply(200, () => {
                                return createStreamFromString('foo');
                            });
                        const value = await scriptSourceProvider.getWidgetScriptSource(moduleName, moduleVersion);

                        assert.deepEqual(value, {
                            moduleName: 'HelloWorld',
                            scriptUri,
                            source: 'cdn'
                        });
                    });

                    test('Retry if busy', async () => {
                        let retryCount = 0;
                        updateCDNSettings(cdn);
                        // when(httpClient.exists(anything())).thenResolve(true);
                        nock(baseUrl).log(console.log).get(/.*/).twice().replyWithError('Not found');
                        nock(baseUrl)
                            .log(console.log)
                            .get(/.*/)
                            .thrice()
                            .reply(200, () => {
                                retryCount = 3;
                                return createStreamFromString('foo');
                            });

                        // Then see if we can get it still.
                        const value = await scriptSourceProvider.getWidgetScriptSource(moduleName, moduleVersion);

                        assert.deepEqual(value, {
                            moduleName: 'HelloWorld',
                            scriptUri,
                            source: 'cdn'
                        });
                        assert.equal(retryCount, 3, 'Did not actually retry');
                    });
                    test('Script source already on disk', async () => {
                        updateCDNSettings(cdn);
                        // Make nobody available
                        // when(httpClient.exists(anything())).thenResolve(true);

                        // Write to where the file should eventually end up
                        const filePath = Uri.parse(scriptUri).fsPath;
                        await fs.createFile(filePath);
                        await fs.writeFile(filePath, 'foo');

                        // Then see if we can get it still.
                        const value = await scriptSourceProvider.getWidgetScriptSource(moduleName, moduleVersion);

                        assert.deepEqual(value, {
                            moduleName: 'HelloWorld',
                            scriptUri,
                            source: 'cdn'
                        });
                    });
                });
            });
        });
    });
});
