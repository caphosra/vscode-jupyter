// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../../platform/common/extensions';

import * as path from 'path';
import {
    Event,
    EventEmitter,
    Uri,
    WebviewOptions,
    WebviewPanel as vscodeWebviewPanel,
    WebviewView as vscodeWebviewView
} from 'vscode';
import { IWebview, IWebviewOptions, WebviewMessage } from '../../../platform/common/application/types';
import { traceError } from '../../../platform/logging';
import { IFileSystem } from '../../../platform/common/platform/types.node';
import { IDisposableRegistry } from '../../../platform/common/types';
import * as localize from '../../../platform/common/utils/localize';
import { EXTENSION_ROOT_DIR } from '../../../platform/constants.node';
import { Identifiers } from '../../webview-side/common/constants';

// Wrapper over a vscode webview. To be used with either WebviewPanel or WebviewView
export abstract class Webview implements IWebview {
    public get loadFailed(): Event<void> {
        return this.loadFailedEmitter.event;
    }
    protected webviewHost?: vscodeWebviewView | vscodeWebviewPanel;
    protected loadFailedEmitter = new EventEmitter<void>();
    protected loadPromise: Promise<void>;

    constructor(
        protected fs: IFileSystem,
        protected disposableRegistry: IDisposableRegistry,
        protected options: IWebviewOptions,
        additionalRootPaths: Uri[] = []
    ) {
        const webViewOptions: WebviewOptions = {
            enableScripts: true,
            localResourceRoots: [Uri.file(this.options.rootPath), Uri.file(this.options.cwd), ...additionalRootPaths]
        };
        if (options.webviewHost) {
            this.webviewHost = options.webviewHost;
            this.webviewHost.webview.options = webViewOptions;
        } else {
            // Delegate to derived classes for creation
            this.webviewHost = this.createWebview(webViewOptions);
        }

        this.loadPromise = this.load();
    }

    public asWebviewUri(localResource: Uri) {
        if (!this.webviewHost?.webview) {
            throw new Error('WebView not initialized, too early to get a Uri');
        }
        return this.webviewHost.webview.asWebviewUri(localResource);
    }

    public postMessage(message: WebviewMessage) {
        if (this.webviewHost?.webview) {
            void this.webviewHost?.webview.postMessage(message);
        }
    }

    // WebviewPanel and WebviewView need their own way to create a webview if not supplied one
    protected abstract createWebview(webviewOptions: WebviewOptions): vscodeWebviewView | vscodeWebviewPanel;

    // After load is finished allow derived classes to hook up class specific code
    protected abstract postLoad(webviewHost: vscodeWebviewView | vscodeWebviewPanel): void;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async generateLocalReactHtml() {
        if (!this.webviewHost?.webview) {
            throw new Error('WebView not initialized, too early to get a Uri');
        }

        const uriBase = this.webviewHost?.webview.asWebviewUri(Uri.file(this.options.cwd)).toString();
        const uris = this.options.scripts.map((script) => this.webviewHost!.webview!.asWebviewUri(Uri.file(script)));
        const testFiles = await this.fs.getFiles(Uri.file(this.options.rootPath));

        // This method must be called so VSC is aware of files that can be pulled.
        // Allow js and js.map files to be loaded by webpack in the webview.
        testFiles
            .filter((f) => f.fsPath.toLowerCase().endsWith('.js') || f.fsPath.toLowerCase().endsWith('.js.map'))
            .forEach((f) => this.webviewHost?.webview!.asWebviewUri(f));

        const rootPath = this.webviewHost.webview.asWebviewUri(Uri.file(this.options.rootPath)).toString();
        const fontAwesomePath = this.webviewHost.webview
            .asWebviewUri(
                Uri.file(
                    path.join(
                        EXTENSION_ROOT_DIR,
                        'out',
                        'fontAwesome',
                        'node_modules',
                        'font-awesome',
                        'css',
                        'font-awesome.min.css'
                    )
                )
            )
            .toString();

        // Check to see if we should force on Test middleware for our react code
        const forceTestMiddleware = process.env.VSC_JUPYTER_WEBVIEW_TEST_MIDDLEWARE || 'false';
        return `<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
                <meta http-equiv="Content-Security-Policy" content="img-src 'self' data: https: http: blob: ${
                    this.webviewHost.webview.cspSource
                }; default-src 'unsafe-inline' 'unsafe-eval' data: https: http: blob: ${
            this.webviewHost.webview.cspSource
        };">
                <meta name="theme-color" content="#000000">
                <meta name="theme" content="${Identifiers.GeneratedThemeName}"/>
                <title>VS Code Python React UI</title>
                <base href="${uriBase}${uriBase.endsWith('/') ? '' : '/'}"/>
                <link rel="stylesheet" href="${fontAwesomePath}">
                </head>
            <body>
                <noscript>You need to enable JavaScript to run this app.</noscript>
                <div id="root"></div>
                <script type="text/javascript">
                    // Public path that will be used by webpack.
                    window.__PVSC_Public_Path = "${rootPath}/";
                    function resolvePath(relativePath) {
                        if (relativePath && relativePath[0] == '.' && relativePath[1] != '.') {
                            return "${uriBase}" + relativePath.substring(1);
                        }

                        return "${uriBase}" + relativePath;
                    }
                    function forceTestMiddleware() {
                        return ${forceTestMiddleware};
                    }
                </script>
                ${uris.map((uri) => `<script type="text/javascript" src="${uri}"></script>`).join('\n')}
            </body>
        </html>`;
    }

    private async load() {
        try {
            if (this.webviewHost?.webview) {
                const localFilesExist = await Promise.all(this.options.scripts.map((s) => this.fs.localFileExists(s)));
                if (localFilesExist.every((exists) => exists === true)) {
                    // Call our special function that sticks this script inside of an html page
                    // and translates all of the paths to vscode-resource URIs
                    this.webviewHost.webview.html = await this.generateLocalReactHtml();

                    // Hook up class specific events after load
                    this.postLoad(this.webviewHost);
                } else {
                    // Indicate that we can't load the file path
                    const badPanelString = localize.DataScience.badWebPanelFormatString();
                    this.webviewHost.webview.html = badPanelString.format(this.options.scripts.join(', '));
                }
            }
        } catch (error) {
            // If our web panel failes to load, report that out so whatever
            // is hosting the panel can clean up
            traceError(`Error Loading WebviewPanel: ${error}`);
            this.loadFailedEmitter.fire();
        }
    }
}
