// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import * as path from 'path';
import * as sinon from 'sinon';
import * as assert from 'assert';
import { Uri } from 'vscode';
import { IPythonExtensionChecker } from '../../../platform/api/types';
import { IVSCodeNotebook } from '../../../platform/common/application/types';
import { traceInfo } from '../../../platform/logging';
import { IDisposable } from '../../../platform/common/types';
import { IExtensionTestApi, waitForCondition } from '../../common';
import { EXTENSION_ROOT_DIR_FOR_TESTS, IS_REMOTE_NATIVE_TEST, IS_NON_RAW_NATIVE_TEST } from '../../constants';
import { initialize } from '../../initialize';
import { openNotebook } from '../helpers';
import {
    closeNotebooks,
    closeNotebooksAndCleanUpAfterTests,
    createTemporaryNotebook,
    runAllCellsInActiveNotebook,
    runCell,
    insertCodeCell,
    insertMarkdownCell,
    saveActiveNotebook,
    waitForExecutionCompletedSuccessfully,
    waitForKernelToGetAutoSelected,
    workAroundVSCodeNotebookStartPages,
    waitForTextOutput
} from './helper';
import { PythonExtensionChecker } from '../../../platform/api/pythonApi.node';
import { NotebookCellLanguageService } from '../../../intellisense/cellLanguageService.node';
import { INotebookEditorProvider } from '../../../notebooks/types';

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('DataScience - VSCode Notebook - Kernels (non-python-kernel) (slow)', () => {
    const juliaNb = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'test',
        'datascience',
        'notebook',
        'simpleJulia.ipynb'
    );
    const csharpNb = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'test',
        'datascience',
        'notebook',
        'simpleCSharp.ipynb'
    );
    const javaNb = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'test',
        'datascience',
        'notebook',
        'simpleJavaBeakerX.ipynb'
    );

    const emptyPythonNb = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'test',
        'datascience',
        'notebook',
        'emptyPython.ipynb'
    );

    let api: IExtensionTestApi;
    const disposables: IDisposable[] = [];
    let vscodeNotebook: IVSCodeNotebook;
    let testJuliaNb: Uri;
    let testJavaNb: Uri;
    let testCSharpNb: Uri;
    let testEmptyPythonNb: Uri;
    let editorProvider: INotebookEditorProvider;
    let languageService: NotebookCellLanguageService;
    const testJavaKernels = (process.env.VSC_JUPYTER_CI_RUN_JAVA_NB_TEST || '').toLowerCase() === 'true';
    suiteSetup(async function () {
        api = await initialize();
        verifyPromptWasNotDisplayed();
        if (!process.env.VSC_JUPYTER_CI_RUN_NON_PYTHON_NB_TEST || IS_REMOTE_NATIVE_TEST || IS_NON_RAW_NATIVE_TEST) {
            return this.skip();
        }
        sinon.restore();
        await workAroundVSCodeNotebookStartPages();
        verifyPromptWasNotDisplayed();
        vscodeNotebook = api.serviceContainer.get<IVSCodeNotebook>(IVSCodeNotebook);
        editorProvider = api.serviceContainer.get<INotebookEditorProvider>(INotebookEditorProvider);
        languageService = api.serviceContainer.get<NotebookCellLanguageService>(NotebookCellLanguageService);
    });
    function verifyPromptWasNotDisplayed() {
        assert.strictEqual(
            PythonExtensionChecker.promptDisplayed,
            undefined,
            'Prompt for requiring Python extension should not have been displayed'
        );
    }
    setup(async function () {
        traceInfo(`Start Test ${this.currentTest?.title}`);
        sinon.restore();
        await closeNotebooks();
        // Don't use same file (due to dirty handling, we might save in dirty.)
        // Coz we won't save to file, hence extension will backup in dirty file and when u re-open it will open from dirty.
        testJuliaNb = Uri.file(await createTemporaryNotebook(juliaNb, disposables));
        testJavaNb = Uri.file(await createTemporaryNotebook(javaNb, disposables));
        testCSharpNb = Uri.file(await createTemporaryNotebook(csharpNb, disposables));
        testEmptyPythonNb = Uri.file(await createTemporaryNotebook(emptyPythonNb, disposables));
        traceInfo(`Start Test (completed) ${this.currentTest?.title}`);
    });
    teardown(async () => {
        verifyPromptWasNotDisplayed();
        await closeNotebooksAndCleanUpAfterTests(disposables);
    });
    test('Automatically pick java kernel when opening a Java Notebook', async function () {
        if (!testJavaKernels) {
            return this.skip();
        }
        await openNotebook(testJavaNb.fsPath);
        await waitForKernelToGetAutoSelected('java');
    });
    test('Automatically pick julia kernel when opening a Julia Notebook', async () => {
        await openNotebook(testJuliaNb.fsPath);
        await waitForKernelToGetAutoSelected('julia');
    });
    test('Automatically pick csharp kernel when opening a csharp notebook', async function () {
        // The .NET interactive CLI does not work if you do not have Jupyter installed.
        // We install Jupyter on CI when we have tests with Python extension.
        // Hence if python extension is not installed, then assume jupyter is not installed on CI.
        // Meaning, no python extension, no jupyter, hence no .NET kernel either.
        const pythonChecker = api.serviceContainer.get<IPythonExtensionChecker>(IPythonExtensionChecker);
        if (!pythonChecker.isPythonExtensionInstalled) {
            return this.skip();
        }
        await openNotebook(testCSharpNb.fsPath);
        await waitForKernelToGetAutoSelected('c#');
    });
    test('New notebook will have a Julia cell if last notebook was a julia nb', async function () {
        return this.skip();
        await openNotebook(testJuliaNb.fsPath);
        await waitForKernelToGetAutoSelected();
        await insertMarkdownCell('# Hello');
        await saveActiveNotebook();

        // Add another cell, to ensure changes are detected by our code.
        await insertMarkdownCell('# Hello');
        await saveActiveNotebook();
        await closeNotebooks();

        // Wait for the default cell language to change.
        await waitForCondition(
            async () => languageService.getPreferredLanguage().toLowerCase() === 'julia',
            10_000,
            `Default cell language is not Julia, it is ${languageService.getPreferredLanguage().toLowerCase()}`
        );
        // Create a blank notebook & confirm we have a julia code cell & julia kernel.
        await editorProvider.createNew();

        await waitForCondition(
            async () =>
                vscodeNotebook.activeNotebookEditor?.document.cellAt(0).document.languageId.toLowerCase() === 'julia',
            5_000,
            `First cell is not julia, it is ${vscodeNotebook.activeNotebookEditor?.document
                .cellAt(0)
                .document.languageId.toLowerCase()}`
        );
        await waitForKernelToGetAutoSelected('julia');

        // Lets try opening a python nb & validate that.
        await closeNotebooks();

        const pythonChecker = api.serviceContainer.get<IPythonExtensionChecker>(IPythonExtensionChecker);
        if (pythonChecker.isPythonExtensionInstalled) {
            // Now open an existing python notebook & confirm kernel is set to Python.
            await openNotebook(testEmptyPythonNb.fsPath);
            await waitForKernelToGetAutoSelected('python');
        }
    });
    test('Can run a Julia notebook', async function () {
        this.timeout(60_000); // Can be slow to start Julia kernel on CI.
        await openNotebook(testJuliaNb.fsPath);
        await insertCodeCell('123456', { language: 'julia', index: 0 });
        const cell = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        // Wait till execution count changes and status is success.
        await Promise.all([
            runCell(cell),
            waitForExecutionCompletedSuccessfully(cell, 60_000),
            waitForTextOutput(cell, '123456', 0, false)
        ]);
    });
    test('Can run a CSharp notebook', async function () {
        // C# Kernels can only be installed when you have Jupyter
        // On CI we install Jupyter only when testing with Python extension.
        const pythonChecker = api.serviceContainer.get<IPythonExtensionChecker>(IPythonExtensionChecker);
        if (!pythonChecker.isPythonExtensionInstalled) {
            return this.skip();
        }
        this.timeout(30_000); // Can be slow to start csharp kernel on CI.
        await openNotebook(testCSharpNb.fsPath);
        await waitForKernelToGetAutoSelected('c#');
        await runAllCellsInActiveNotebook();

        const cell = vscodeNotebook.activeNotebookEditor?.document.cellAt(0)!;
        // Wait till execution count changes and status is success.
        await waitForExecutionCompletedSuccessfully(cell);

        // For some reason C# kernel sends multiple outputs.
        // First output can contain `text/html` with some Jupyter UI specific stuff.
        try {
            traceInfo(`Cell output length ${cell.outputs.length}`);
            await waitForTextOutput(cell, 'Hello', 0, false, 5_000);
        } catch (ex) {
            if (cell.outputs.length > 1) {
                await waitForTextOutput(cell, 'Hello', 1, false);
            } else {
                throw ex;
            }
        }
    });
});
