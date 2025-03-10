/* eslint-disable @typescript-eslint/no-explicit-any */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { assert } from 'chai';
import * as path from 'path';
import * as fsExtra from 'fs-extra';
import * as sinon from 'sinon';
import { anything, instance, mock, when, verify } from 'ts-mockito';
import { PathUtils } from '../../../platform/common/platform/pathUtils.node';
import { IPlatformService } from '../../../platform/common/platform/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts.node';
import { WorkspaceService } from '../../../platform/common/application/workspace';
import { EnvironmentVariablesProvider } from '../../../platform/common/variables/environmentVariablesProvider.node';
import { InterpreterService, PythonExtensionChecker } from '../../../platform/api/pythonApi.node';
import {
    createInterpreterKernelSpec,
    getInterpreterKernelSpecName,
    getKernelId,
    getKernelRegistrationInfo
} from '../../../platform/../kernels/helpers.node';
import { PlatformService } from '../../../platform/common/platform/platformService.node';
import { EXTENSION_ROOT_DIR } from '../../../platform/constants.node';
import { FileSystem } from '../../../platform/common/platform/fileSystem.node';
import type { KernelSpec } from '@jupyterlab/services';
import { EnvironmentType, PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { IPythonExtensionChecker } from '../../../platform/api/types';
import { PYTHON_LANGUAGE } from '../../../platform/common/constants';
import { getOSType } from '../../common';
import { EventEmitter, Memento, Uri } from 'vscode';
import { IDisposable, IExtensionContext } from '../../../platform/common/types';
import { getInterpreterHash } from '../../../platform/pythonEnvironments/info/interpreter.node';
import { OSType } from '../../../platform/common/utils/platform';
import { disposeAllDisposables } from '../../../platform/common/helpers.node';
import { KernelConnectionMetadata, LocalKernelConnectionMetadata } from '../../../platform/../kernels/types';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths.node';
import { arePathsSame } from '../../../platform/common/platform/fileUtils.node';
import { JupyterPaths } from '../../../kernels/raw/finder/jupyterPaths.node';
import { LocalKernelFinder } from '../../../kernels/raw/finder/localKernelFinder.node';
import { loadKernelSpec } from '../../../kernels/raw/finder/localKernelSpecFinderBase.node';
import { LocalKnownPathKernelSpecFinder } from '../../../kernels/raw/finder/localKnownPathKernelSpecFinder.node';
import { LocalPythonAndRelatedNonPythonKernelSpecFinder } from '../../../kernels/raw/finder/localPythonAndRelatedNonPythonKernelSpecFinder.node';
import { ILocalKernelFinder } from '../../../kernels/raw/types';
import { IFileSystem } from '../../../platform/common/platform/types.node';

[false, true].forEach((isWindows) => {
    suite(`Local Kernel Finder ${isWindows ? 'Windows' : 'Unix'}`, () => {
        let kernelFinder: ILocalKernelFinder;
        let interpreterService: IInterpreterService;
        let platformService: IPlatformService;
        let fs: IFileSystem;
        let extensionChecker: IPythonExtensionChecker;
        const disposables: IDisposable[] = [];
        let globalSpecPath: string;
        let tempDirForKernelSpecs: string;
        const pathSeparator = getOSType() === OSType.Windows ? '\\' : '/';
        let jupyterPaths: JupyterPaths;
        type TestData = {
            interpreters?: (
                | PythonEnvironment
                | {
                      interpreter: PythonEnvironment;
                      /**
                       * These are all of the kernelspecs found within the Python environment.
                       * Could be python or non-python kernlespecs.
                       * Could be default or custom kernelspecs.
                       */
                      kernelSpecs?: KernelSpec.ISpecModel[];
                  }
            )[];
            /**
             * All of the globally installed KernelSpecs
             */
            globalKernelSpecs?: KernelSpec.ISpecModel[];
        };

        async function initialize(testData: TestData, activeInterpreter?: PythonEnvironment) {
            const getRealPathStub = sinon.stub(fsExtra, 'realpath');
            getRealPathStub.returnsArg(0);
            interpreterService = mock(InterpreterService);
            // Ensure the active Interpreter is in the list of interpreters.
            if (activeInterpreter) {
                testData.interpreters = testData.interpreters || [];
                testData.interpreters.push(activeInterpreter);
            }
            const distinctInterpreters = new Set<PythonEnvironment>();
            (testData.interpreters || []).forEach((item) =>
                'interpreter' in item ? distinctInterpreters.add(item.interpreter) : distinctInterpreters.add(item)
            );
            testData.interpreters = Array.from(distinctInterpreters);
            when(interpreterService.getInterpreters(anything())).thenResolve(Array.from(distinctInterpreters));
            when(interpreterService.getActiveInterpreter(anything())).thenResolve(activeInterpreter);
            when(interpreterService.getInterpreterDetails(anything())).thenResolve();
            platformService = mock(PlatformService);
            when(platformService.isWindows).thenReturn(isWindows);
            when(platformService.isLinux).thenReturn(!isWindows);
            when(platformService.isMac).thenReturn(false);
            fs = mock(FileSystem);
            when(fs.deleteLocalFile(anything())).thenResolve();
            when(fs.localFileExists(anything())).thenResolve(true);
            const pathUtils = new PathUtils(isWindows);
            const workspaceService = mock(WorkspaceService);
            const testWorkspaceFolder = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience');

            when(workspaceService.getWorkspaceFolderIdentifier(anything(), anything())).thenCall((_a, b) => {
                return Promise.resolve(b);
            });
            when(workspaceService.rootPath).thenReturn(testWorkspaceFolder);
            const envVarsProvider = mock(EnvironmentVariablesProvider);
            when(envVarsProvider.getEnvironmentVariables()).thenResolve({});
            const event = new EventEmitter<Uri | undefined>();
            disposables.push(event);
            when(envVarsProvider.onDidEnvironmentVariablesChange).thenReturn(event.event);
            extensionChecker = mock(PythonExtensionChecker);
            when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);
            const memento = mock<Memento>();
            const context = mock<IExtensionContext>();
            when(context.extensionUri).thenReturn(Uri.file(EXTENSION_ROOT_DIR));
            when(memento.get(anything(), anything())).thenReturn(false);
            when(memento.update(anything(), anything())).thenResolve();
            jupyterPaths = new JupyterPaths(
                instance(platformService),
                pathUtils,
                instance(envVarsProvider),
                disposables,
                instance(memento),
                instance(fs),
                instance(context)
            );

            const kernelSpecsBySpecFile = new Map<string, KernelSpec.ISpecModel>();
            (testData.interpreters || []).forEach((interpreter) => {
                if ('interpreter' in interpreter) {
                    (interpreter.kernelSpecs || []).forEach((kernelSpec) => {
                        const jsonFile = [
                            interpreter.interpreter.sysPrefix,
                            'share',
                            'jupyter',
                            'kernels',
                            kernelSpec.name,
                            'kernel.json'
                        ].join(pathSeparator);
                        kernelSpecsBySpecFile.set(jsonFile, kernelSpec);
                    });
                }
            });
            globalSpecPath = (await jupyterPaths.getKernelSpecRootPath()) as unknown as string;
            tempDirForKernelSpecs = (await jupyterPaths.getKernelSpecTempRegistrationFolder()) as unknown as string;
            await Promise.all(
                (testData.globalKernelSpecs || []).map(async (kernelSpec) => {
                    const jsonFile = [globalSpecPath, kernelSpec.name, 'kernel.json'].join(pathSeparator);
                    kernelSpecsBySpecFile.set(jsonFile.replace(/\\/g, '/'), kernelSpec);
                })
            );
            when(fs.readLocalFile(anything())).thenCall((f) => {
                // These tests run on windows & linux, hence support both paths.
                f = f.replace(/\\/g, '/');
                return kernelSpecsBySpecFile.has(f)
                    ? Promise.resolve(JSON.stringify(kernelSpecsBySpecFile.get(f)!))
                    : Promise.reject(`File "${f}" not found.`);
            });
            when(fs.searchLocal(anything(), anything(), true)).thenCall((_p, c: string, _d) => {
                if (c === globalSpecPath) {
                    return (testData.globalKernelSpecs || []).map((kernelSpec) =>
                        [kernelSpec.name, 'kernel.json'].join(pathSeparator)
                    );
                }
                const interpreter = (testData.interpreters || []).find((item) =>
                    'interpreter' in item ? c.includes(item.interpreter.sysPrefix) : c.includes(item.sysPrefix)
                );
                if (interpreter && 'interpreter' in interpreter) {
                    return (interpreter.kernelSpecs || []).map((kernelSpec) =>
                        [kernelSpec.name, 'kernel.json'].join(pathSeparator)
                    );
                }
                return [];
            });
            when(fs.areLocalPathsSame(anything(), anything())).thenCall((a, b) => {
                return arePathsSame(a, b);
            });
            when(fs.ensureLocalDir(anything())).thenResolve();
            when(fs.deleteLocalFile(anything())).thenResolve();
            when(fs.copyLocal(anything(), anything())).thenResolve();
            when(fs.localDirectoryExists(anything())).thenResolve(true);
            const nonPythonKernelSpecFinder = new LocalKnownPathKernelSpecFinder(
                instance(fs),
                instance(workspaceService),
                jupyterPaths,
                instance(extensionChecker),
                instance(memento)
            );
            when(memento.get('LOCAL_KERNEL_SPEC_CONNECTIONS_CACHE_KEY_V2', anything())).thenReturn([]);
            when(memento.get('JUPYTER_GLOBAL_KERNELSPECS_V2', anything())).thenReturn([]);
            when(memento.update('JUPYTER_GLOBAL_KERNELSPECS_V2', anything())).thenResolve();
            kernelFinder = new LocalKernelFinder(
                instance(interpreterService),
                instance(extensionChecker),
                nonPythonKernelSpecFinder,
                new LocalPythonAndRelatedNonPythonKernelSpecFinder(
                    instance(interpreterService),
                    instance(fs),
                    instance(workspaceService),
                    jupyterPaths,
                    instance(extensionChecker),
                    nonPythonKernelSpecFinder,
                    instance(memento)
                ),
                instance(memento),
                instance(fs)
            );
        }
        teardown(() => {
            disposeAllDisposables(disposables);
            sinon.restore();
        });

        const juliaKernelSpec: KernelSpec.ISpecModel = {
            argv: ['julia', 'start', 'kernel'],
            display_name: 'Julia Kernel',
            language: 'julia',
            name: 'julia',
            resources: {}
        };
        const rKernelSpec: KernelSpec.ISpecModel = {
            argv: ['r', 'start', 'kernel'],
            display_name: 'R Kernel',
            language: 'r',
            name: 'r',
            resources: {}
        };
        const rV1KernelSpec: KernelSpec.ISpecModel = {
            argv: ['rv1', 'start', 'kernel'],
            display_name: 'R Kernel',
            language: 'r',
            name: 'rv1',
            resources: {}
        };
        const defaultPython3Kernel: KernelSpec.ISpecModel = {
            argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            display_name: 'Python 3',
            language: 'python',
            name: 'python3',
            resources: {}
        };
        const defaultPython3KernelWithEnvVars: KernelSpec.ISpecModel = {
            argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            display_name: 'Python 3',
            language: 'python',
            name: 'python3',
            resources: {},
            env: {
                HELLO: 'WORLD'
            }
        };
        const customPythonKernelWithCustomArgv: KernelSpec.ISpecModel = {
            argv: ['python', '-m', 'customKernel'],
            display_name: 'Custom Python Kernel',
            language: 'python',
            name: 'customPythonKernel',
            resources: {}
        };
        const customPythonKernelWithCustomEnv: KernelSpec.ISpecModel = {
            argv: ['python', '-m', 'ipykernel', '-f', '{connection_file}'],
            display_name: 'Custom Python Kernel with Env Vars',
            language: 'python',
            name: 'customPythonKernelWithCustomEnv',
            resources: {},
            env: {
                HELLO: 'WORLD'
            }
        };
        const python2Global: PythonEnvironment = {
            path: isWindows ? 'C:/Python/Python2/scripts/python.exe' : '/usr/bin/python27',
            sysPrefix: isWindows ? 'C:/Python/Python2' : '/usr',
            displayName: 'Python 2.7',
            envType: EnvironmentType.Global,
            sysVersion: '2.7.0',
            version: { major: 2, minor: 7, patch: 0, build: [], prerelease: [], raw: '2.7.0' }
        };
        const python36Global: PythonEnvironment = {
            path: isWindows ? 'C:/Python/Python3.6/scripts/python.exe' : '/usr/bin/python36',
            sysPrefix: isWindows ? 'C:/Python/Python3.6' : '/usr',
            displayName: 'Python 3.6',
            envType: EnvironmentType.Global,
            sysVersion: '3.6.0',
            version: { major: 3, minor: 6, patch: 0, build: [], prerelease: [], raw: '3.6.0' }
        };
        const python37Global: PythonEnvironment = {
            path: isWindows ? 'C:/Python/Python3.7/scripts/python.exe' : '/usr/bin/python37',
            sysPrefix: isWindows ? 'C:/Python/Python3.7' : '/usr',
            displayName: 'Python 3.7',
            envType: EnvironmentType.Global,
            sysVersion: '3.7.0',
            version: { major: 3, minor: 7, patch: 0, build: [], prerelease: [], raw: '3.6.0' }
        };
        const python39PyEnv_HelloWorld: PythonEnvironment = {
            path: isWindows ? 'C:/pyenv/envs/temp/scripts/python.exe' : '/users/username/pyenv/envs/temp/python',
            sysPrefix: isWindows ? 'C:/pyenv/envs/temp' : '/users/username/pyenv/envs/temp',
            displayName: 'Temporary Python 3.9',
            envName: 'temp',
            envType: EnvironmentType.Pyenv,
            sysVersion: '3.9.0',
            version: { major: 3, minor: 9, patch: 0, build: [], prerelease: [], raw: '3.9.0' }
        };
        const python38PyEnv_temp1: PythonEnvironment = {
            path: isWindows ? 'C:/pyenv/envs/temp1/scripts/python.exe' : '/users/username/pyenv/envs/temp1/bin/python',
            sysPrefix: isWindows ? 'C:/pyenv/envs/temp1' : '/users/username/pyenv/envs/temp1',
            displayName: 'Temporary Python 3.8 64bit Environment',
            envName: 'temp1',
            envType: EnvironmentType.Pyenv,
            sysVersion: '3.8.0',
            version: { major: 3, minor: 8, patch: 0, build: [], prerelease: [], raw: '3.8.0' }
        };
        const python38PyEnv_temp2_duplicateNameAsTemp1: PythonEnvironment = {
            path: isWindows ? 'C:/pyenv/envs/temp2/scripts/python.exe' : '/users/username/pyenv/envs/temp2/bin/python',
            sysPrefix: isWindows ? 'C:/pyenv/envs/temp2' : '/users/username/pyenv/envs/temp2',
            displayName: 'Temporary Python 3.8 64bit Environment',
            envName: 'temp2',
            envType: EnvironmentType.Pyenv,
            sysVersion: '3.8.0',
            version: { major: 3, minor: 8, patch: 0, build: [], prerelease: [], raw: '3.8.0' }
        };
        const python38PyEnv_temp3_duplicateNameAsTemp1: PythonEnvironment = {
            path: isWindows ? 'C:/pyenv/envs/temp3/scripts/python.exe' : '/users/username/pyenv/envs/temp3/bin/python',
            sysPrefix: isWindows ? 'C:/pyenv/envs/temp3' : '/users/username/pyenv/envs/temp3',
            displayName: 'Temporary Python 3.8 64bit Environment',
            envName: 'temp3',
            envType: EnvironmentType.Pyenv,
            sysVersion: '3.8.11',
            version: { major: 3, minor: 8, patch: 11, build: [], prerelease: [], raw: '3.8.11' }
        };
        /**
         * Identical to python38PyEnv_temp2_duplicateNameAsTemp1 & python38PyEnv_temp2_duplicateNameAsTemp2
         * Except on unix the executable is not in a bin folder.
         */
        const python38PyEnv_temp4_duplicateNameAsTemp1ButNoBin: PythonEnvironment = {
            path: isWindows ? 'C:/pyenv/envs/temp4/scripts/python.exe' : '/users/username/pyenv/envs/temp4/python',
            sysPrefix: isWindows ? 'C:/pyenv/envs/temp4' : '/users/username/pyenv/envs/temp4',
            displayName: 'Temporary Python 3.8 64bit Environment',
            envName: 'temp4',
            envType: EnvironmentType.Pyenv,
            sysVersion: '3.8.0',
            version: { major: 3, minor: 8, patch: 0, build: [], prerelease: [], raw: '3.8.0' }
        };
        const duplicate1OfPython38PyEnv_temp1 = python38PyEnv_temp1;
        const python38VenvEnv: PythonEnvironment = {
            path: isWindows ? 'C:/temp/venv/.venv/scripts/python.exe' : '/users/username/temp/.venv/bin/python',
            sysPrefix: isWindows ? 'C:/temp/venv/.venv' : '/users/username/temp/.venv',
            displayName: 'Virtual Env Python 3.8',
            envName: '.venv',
            envType: EnvironmentType.VirtualEnv,
            sysVersion: '3.8.0',
            version: { major: 3, minor: 8, patch: 0, build: [], prerelease: [], raw: '3.8.0' }
        };
        const condaEnv1: PythonEnvironment = {
            path: isWindows ? 'C:/conda/envs/env1/scripts/python.exe' : '/conda/envs/env1/bin/python',
            sysPrefix: isWindows ? 'C:/conda/envs/env1' : '/conda/envs/env1',
            envName: 'env1',
            displayName: 'Conda Env1 3.6',
            envType: EnvironmentType.Conda,
            sysVersion: '3.6.0',
            version: { major: 3, minor: 6, patch: 0, build: [], prerelease: [], raw: '3.6.0' }
        };
        const javaKernelSpec: KernelSpec.ISpecModel = {
            argv: ['java', 'xyz.jar', '{connection_file}', 'moreargs'],
            display_name: 'Java Kernel',
            language: 'java',
            name: 'javaKernelInsideConda',
            resources: {},
            env: {
                HELLO: 'Java'
            }
        };
        const python2spec: KernelSpec.ISpecModel = {
            display_name: 'Python 2 on Disk',
            name: 'python2Custom',
            argv: [python2Global.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            language: 'python',
            resources: {}
        };

        const fullyQualifiedPythonKernelSpec: KernelSpec.ISpecModel = {
            argv: [python38VenvEnv.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}', 'moreargs'],
            display_name: 'Custom .venv Kernel',
            language: 'python',
            name: 'fullyQualifiedPythonKernelSpec',
            resources: {}
        };

        const fullyQualifiedPythonKernelSpecForGlobalPython36: KernelSpec.ISpecModel = {
            argv: [python36Global.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            display_name: 'Custom Kernel for Global Python 36',
            language: 'python',
            name: 'fullyQualifiedPythonKernelSpecForGlobalPython36',
            resources: {}
        };
        const fullyQualifiedPythonKernelSpecForGlobalPython36WithCustomEnvVars: KernelSpec.ISpecModel = {
            argv: [python36Global.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            display_name: 'Custom Kernel for Global Python 36 with Custom Env Vars',
            language: 'python',
            name: 'fullyQualifiedPythonKernelSpecForGlobalPython36WithCustomEnvVars',
            resources: {}
        };
        const fullyQualifiedPythonKernelSpecWithEnv: KernelSpec.ISpecModel = {
            argv: [python38VenvEnv.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}', 'moreargs'],
            display_name: 'Custom .venv Kernel with Env Vars',
            language: 'python',
            name: 'fullyQualifiedPythonKernelSpecWithEnv',
            resources: {},
            env: {
                FOO: 'BAR'
            }
        };
        const kernelspecRegisteredByOlderVersionOfExtension: KernelSpec.ISpecModel = {
            argv: [python38VenvEnv.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}', 'moreargs'],
            display_name: 'Kernelspec registered by older version of extension',
            language: 'python',
            // Most recent versions of extensions used a custom prefix in kernelnames.
            name: `${getInterpreterKernelSpecName(python38VenvEnv)}kernelSpecRegisteredByOlderVersionOfExtension`,
            resources: {},
            env: {
                HELLO: 'World'
            }
        };
        const kernelspecRegisteredByVeryOldVersionOfExtension: KernelSpec.ISpecModel = {
            argv: [python38VenvEnv.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            display_name: 'Kernelspec registered by very old version of extension',
            language: 'python',
            // Initial versions of extensions used a GUID in kernelnames & contained the interpreter in metadata.
            name: `kernelspecRegisteredByVeryOldVersionOfExtensionaaaa1111222233334444555566667777`,
            resources: {},
            env: {
                HELLO: 'World',
                FOO: 'Bar'
            },
            metadata: {
                interpreter: { ...python38VenvEnv }
            }
        };

        async function generateExpectedKernels(
            expectedGlobalKernelSpecs: KernelSpec.ISpecModel[],
            expectedInterpreterKernelSpecFiles: { interpreter: PythonEnvironment; kernelspec: KernelSpec.ISpecModel }[],
            expectedInterpreters: PythonEnvironment[]
        ) {
            const duplicates = new Set<PythonEnvironment>();
            expectedInterpreters = expectedInterpreters.filter((item) => {
                if (duplicates.has(item)) {
                    return false;
                }
                duplicates.add(item);
                return true;
            });
            const expectedKernelSpecs: KernelConnectionMetadata[] = [];
            await Promise.all(
                expectedGlobalKernelSpecs.map(async (kernelSpec) => {
                    const kernelspecFile = [globalSpecPath, kernelSpec.name, 'kernel.json'].join(pathSeparator);
                    const interpreter = expectedInterpreters.find(
                        (item) => kernelSpec.language === PYTHON_LANGUAGE && item.path === kernelSpec.argv[0]
                    );
                    const spec = await loadKernelSpec(kernelspecFile, instance(fs));
                    if (spec) {
                        expectedKernelSpecs.push(<KernelConnectionMetadata>{
                            id: getKernelId(spec!, interpreter),
                            kernelSpec: spec,
                            interpreter,
                            kind: 'startUsingLocalKernelSpec'
                        });
                    }
                })
            );
            await Promise.all(
                expectedInterpreterKernelSpecFiles.map(async ({ interpreter, kernelspec }) => {
                    const kernelSpecFile = [
                        interpreter.sysPrefix,
                        'share',
                        'jupyter',
                        'kernels',
                        kernelspec.name,
                        'kernel.json'
                    ].join(pathSeparator);
                    const spec = await loadKernelSpec(kernelSpecFile, instance(fs), interpreter);
                    if (spec) {
                        expectedKernelSpecs.push(<KernelConnectionMetadata>{
                            id: getKernelId(spec!, interpreter),
                            kernelSpec: spec,
                            interpreter: spec.language === PYTHON_LANGUAGE ? interpreter : undefined,
                            kind:
                                spec.language === PYTHON_LANGUAGE
                                    ? 'startUsingPythonInterpreter'
                                    : 'startUsingLocalKernelSpec'
                        });
                    }
                })
            );
            await Promise.all(
                expectedInterpreters.map(async (interpreter) => {
                    const spec = createInterpreterKernelSpec(interpreter, tempDirForKernelSpecs);
                    expectedKernelSpecs.push(<KernelConnectionMetadata>{
                        id: getKernelId(spec!, interpreter),
                        kernelSpec: spec,
                        interpreter,
                        kind: 'startUsingPythonInterpreter'
                    });
                })
            );
            expectedKernelSpecs.sort((a, b) => a.id.localeCompare(b.id));
            return expectedKernelSpecs;
        }
        type ExpectedKernels = {
            /**
             * Expected list of global kernelspecs.
             */
            expectedGlobalKernelSpecs?: KernelSpec.ISpecModel[];
            /**
             * Expected list of kernlespecs that are associated with a Python interpreter.
             */
            expectedInterpreterKernelSpecFiles?: {
                interpreter: PythonEnvironment;
                kernelspec: KernelSpec.ISpecModel;
            }[];
            /**
             * Expected list of kernlespecs used to start Python environments.
             */
            expectedInterpreters?: PythonEnvironment[];
        };
        type ExpectedKernel =
            | {
                  /**
                   * Expected global kernelspec.
                   */
                  expectedGlobalKernelSpec: KernelSpec.ISpecModel;
              }
            /**
             * Expected list of kernlespecs that are associated with a Python interpreter.
             */
            | {
                  expectedInterpreterKernelSpecFile: {
                      interpreter: PythonEnvironment;
                      kernelspec: KernelSpec.ISpecModel;
                  };
              }
            /**
             * Expected Python environment that will be used to start the kernel.
             */
            | { expectedInterpreter: PythonEnvironment };
        /**
         * Gets the list of kernels from the kernel provider and compares them against what's expected.
         */
        async function verifyKernels(expectations: ExpectedKernels) {
            const actualKernels = await kernelFinder.listKernels(undefined);
            const expectedKernels = await generateExpectedKernels(
                expectations.expectedGlobalKernelSpecs || [],
                expectations.expectedInterpreterKernelSpecFiles || [],
                expectations.expectedInterpreters || []
            );

            assert.equal(actualKernels.length, expectedKernels.length, 'Incorrect # of kernels');
            actualKernels.sort((a, b) => a.id.localeCompare(b.id));
            expectedKernels.sort((a, b) => a.id.localeCompare(b.id));
            try {
                assert.deepEqual(actualKernels, expectedKernels, 'Incorrect kernels');
            } catch (ex) {
                // Compare them one by one for better errors.
                actualKernels.forEach((actual, index) => {
                    const expected = expectedKernels[index];
                    assert.deepEqual(actual, expected);
                });
            }

            // Ensure none of the kernels have duplicate ids.
            const ids = new Map<string, LocalKernelConnectionMetadata>();
            actualKernels.forEach((kernel) => {
                const duplicate = ids.get(kernel.id);
                if (duplicate) {
                    throw new Error(
                        `Duplicate kernel id found ${kernel.id} (${getDisplayPath(
                            kernel.kernelSpec.specFile
                        )}), duplicate of ${duplicate.kernelSpec.display_name} (${getDisplayPath(
                            duplicate.kernelSpec.specFile
                        )})`
                    );
                }
                if (!kernel.kernelSpec.specFile) {
                    // All kernels must have a specFile defined.
                    throw new Error(
                        `Kernelspec file not defined for ${kernel.id} (${getDisplayPath(kernel.kernelSpec.specFile)})`
                    );
                }
                ids.set(kernel.id, kernel);
            });
        }
        async function verifyKernel(
            actualKernel: KernelConnectionMetadata | undefined,
            expectedKernelInfo: ExpectedKernel
        ) {
            const expectedGlobalKernelSpecs =
                'expectedGlobalKernelSpec' in expectedKernelInfo ? [expectedKernelInfo.expectedGlobalKernelSpec] : [];

            const expectedKernels = await generateExpectedKernels(
                expectedGlobalKernelSpecs,
                'expectedInterpreterKernelSpecFile' in expectedKernelInfo
                    ? [expectedKernelInfo.expectedInterpreterKernelSpecFile]
                    : [],
                'expectedInterpreter' in expectedKernelInfo ? [expectedKernelInfo.expectedInterpreter] : []
            );
            const expectedKernel = expectedKernels.find((item) => {
                // if we have a global kernel, then we are expected to start a kernelspec.
                if (expectedGlobalKernelSpecs.length) {
                    return item.kind === 'startUsingLocalKernelSpec';
                }
                return item.kind === 'startUsingPythonInterpreter';
            });
            assert.deepEqual(actualKernel, expectedKernel, 'Incorrect kernels');
        }
        test('Discover global kernelspecs (without Python)', async () => {
            const testData: TestData = {
                globalKernelSpecs: [juliaKernelSpec, javaKernelSpec, fullyQualifiedPythonKernelSpec],
                interpreters: []
            };
            await initialize(testData);
            when(extensionChecker.isPythonExtensionInstalled).thenReturn(false);

            await verifyKernels({
                expectedGlobalKernelSpecs: [juliaKernelSpec, javaKernelSpec, fullyQualifiedPythonKernelSpec]
            });
        });
        test('Discover global custom Python kernelspecs (without Python)', async () => {
            const testData: TestData = {
                globalKernelSpecs: [fullyQualifiedPythonKernelSpec],
                interpreters: []
            };
            await initialize(testData);
            when(extensionChecker.isPythonExtensionInstalled).thenReturn(false);

            await verifyKernels({
                expectedGlobalKernelSpecs: [fullyQualifiedPythonKernelSpec],
                expectedInterpreters: []
            });
        });
        function verifyGlobalKernelSpec(actual: KernelConnectionMetadata | undefined, expected: KernelSpec.ISpecModel) {
            assert.ok(actual, `${expected.display_name} Kernelspec not found`);
            if (actual?.kind === 'connectToLiveKernel') {
                throw new Error('Incorrect value');
            }
            assert.strictEqual(actual?.kind, 'startUsingLocalKernelSpec');
            assert.strictEqual(
                actual?.kernelSpec.specFile,
                [globalSpecPath, expected.name, 'kernel.json'].join(pathSeparator)
            );
            Object.keys(expected).forEach((key) => {
                // We always mess around with the names, hence don't compare names.
                if (key === 'name') {
                    return;
                }
                const actualValue = (actual?.kernelSpec as any)[key] as any;
                if (key === 'env' || key === 'resources') {
                    assert.deepEqual(
                        actualValue || {},
                        expected[key] || {},
                        `Incorrect value for ${key} (kernel '${expected.display_name}')`
                    );
                } else {
                    assert.deepEqual(
                        actualValue,
                        expected[key],
                        `Incorrect value for ${key} (kernel '${expected.display_name}')`
                    );
                }
            });
        }
        test('Verify Global KernelSpecs', async () => {
            const testData: TestData = {
                globalKernelSpecs: [
                    juliaKernelSpec,
                    javaKernelSpec,
                    defaultPython3Kernel,
                    fullyQualifiedPythonKernelSpec
                ]
            };
            await initialize(testData);
            const kernels = await kernelFinder.listKernels(undefined);
            verifyGlobalKernelSpec(
                kernels.find((item) => item.kernelSpec.display_name === juliaKernelSpec.display_name),
                juliaKernelSpec
            );
            verifyGlobalKernelSpec(
                kernels.find((item) => item.kernelSpec.display_name === javaKernelSpec.display_name),
                javaKernelSpec
            );
            verifyGlobalKernelSpec(
                kernels.find((item) => item.kernelSpec.display_name === defaultPython3Kernel.display_name),
                defaultPython3Kernel
            );
            verifyGlobalKernelSpec(
                kernels.find((item) => item.kernelSpec.display_name === fullyQualifiedPythonKernelSpec.display_name),
                fullyQualifiedPythonKernelSpec
            );
        });
        test('Kernelspecs registered by older versions of extensions `should not` be displayed & must be deleted', async () => {
            const testData: TestData = {
                globalKernelSpecs: [
                    juliaKernelSpec,
                    javaKernelSpec,
                    defaultPython3Kernel,
                    fullyQualifiedPythonKernelSpec,
                    kernelspecRegisteredByOlderVersionOfExtension,
                    kernelspecRegisteredByVeryOldVersionOfExtension
                ]
            };
            await initialize(testData);
            const kernels = await kernelFinder.listKernels(undefined);
            // console.error(kernels);
            assert.isUndefined(
                kernels.find(
                    (item) =>
                        item.kernelSpec.display_name === kernelspecRegisteredByOlderVersionOfExtension.display_name ||
                        item.kernelSpec.name === kernelspecRegisteredByOlderVersionOfExtension.name ||
                        item.kernelSpec.display_name === kernelspecRegisteredByVeryOldVersionOfExtension.display_name ||
                        item.kernelSpec.name === kernelspecRegisteredByVeryOldVersionOfExtension.name
                ),
                'Should not list kernels registered by older version of extension'
            );

            // Verify we deleted the old kernelspecs.
            const globalKernelSpecDir = await jupyterPaths.getKernelSpecRootPath();
            const kernelSpecsToBeDeleted = [
                path.join(globalKernelSpecDir!, kernelspecRegisteredByOlderVersionOfExtension.name, 'kernel.json'),
                path.join(globalKernelSpecDir!, kernelspecRegisteredByVeryOldVersionOfExtension.name, 'kernel.json')
            ];

            // Verify files were copied to some other location before being deleted.
            verify(fs.copyLocal(kernelSpecsToBeDeleted[0], anything())).calledBefore(
                fs.deleteLocalFile(kernelSpecsToBeDeleted[0])
            );
            verify(fs.copyLocal(kernelSpecsToBeDeleted[1], anything())).calledBefore(
                fs.deleteLocalFile(kernelSpecsToBeDeleted[1])
            );

            // Verify files were deleted.
            verify(fs.deleteLocalFile(kernelSpecsToBeDeleted[0])).atLeast(1);
            verify(fs.deleteLocalFile(kernelSpecsToBeDeleted[1])).atLeast(1);
        });

        [
            undefined,
            python2Global,
            python38VenvEnv,
            python36Global,
            python37Global,
            python39PyEnv_HelloWorld,
            condaEnv1
        ].forEach((activePythonEnv) => {
            suite(
                activePythonEnv ? `With active Python (${activePythonEnv.displayName})` : 'without active Python',
                () => {
                    test('Discover global custom Python kernelspecs', async () => {
                        const testData: TestData = {
                            globalKernelSpecs: [fullyQualifiedPythonKernelSpec],
                            interpreters: [{ interpreter: python38VenvEnv }]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        await verifyKernels({
                            expectedGlobalKernelSpecs: [fullyQualifiedPythonKernelSpec],
                            expectedInterpreters: [python38VenvEnv].concat(activePythonEnv ? [activePythonEnv] : [])
                        });
                    });
                    test('Discover default Python kernelspecs with env vars', async () => {
                        const testData: TestData = {
                            interpreters: [
                                {
                                    interpreter: python38VenvEnv,
                                    kernelSpecs: [defaultPython3KernelWithEnvVars]
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        await verifyKernels({
                            expectedInterpreterKernelSpecFiles: [
                                {
                                    interpreter: python38VenvEnv,
                                    kernelspec: defaultPython3KernelWithEnvVars
                                }
                            ],
                            expectedInterpreters: [python38VenvEnv].concat(activePythonEnv ? [activePythonEnv] : [])
                        });
                    });
                    test('If we have a kernelspec without custom kernelspecs nor custom args, we should still list this', async () => {
                        const testData: TestData = {
                            interpreters: [python36Global],
                            globalKernelSpecs: [fullyQualifiedPythonKernelSpecForGlobalPython36]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        await verifyKernels({
                            expectedGlobalKernelSpecs: [fullyQualifiedPythonKernelSpecForGlobalPython36],
                            expectedInterpreters: [python36Global].concat(activePythonEnv ? [activePythonEnv] : [])
                        });
                    });
                    test('If two kernelspecs share the same interpreter, but have different env variables, then both should be listed', async () => {
                        const testData: TestData = {
                            interpreters: [
                                {
                                    interpreter: python38VenvEnv,
                                    kernelSpecs: [defaultPython3KernelWithEnvVars]
                                },
                                python36Global
                            ],
                            globalKernelSpecs: [
                                fullyQualifiedPythonKernelSpecForGlobalPython36,
                                fullyQualifiedPythonKernelSpecForGlobalPython36WithCustomEnvVars
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        await verifyKernels({
                            expectedInterpreterKernelSpecFiles: [
                                {
                                    interpreter: python38VenvEnv,
                                    kernelspec: defaultPython3KernelWithEnvVars
                                }
                            ],
                            expectedGlobalKernelSpecs: [
                                fullyQualifiedPythonKernelSpecForGlobalPython36,
                                fullyQualifiedPythonKernelSpecForGlobalPython36WithCustomEnvVars
                            ],
                            expectedInterpreters: [python38VenvEnv, python36Global].concat(
                                activePythonEnv ? [activePythonEnv] : []
                            )
                        });
                    });
                    test('Discover multiple global kernelspecs and a custom Python kernelspecs', async () => {
                        const testData: TestData = {
                            globalKernelSpecs: [juliaKernelSpec, javaKernelSpec, fullyQualifiedPythonKernelSpec],
                            interpreters: [{ interpreter: python38VenvEnv }]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        await verifyKernels({
                            expectedGlobalKernelSpecs: [
                                juliaKernelSpec,
                                javaKernelSpec,
                                fullyQualifiedPythonKernelSpec
                            ],
                            expectedInterpreters: [python38VenvEnv].concat(activePythonEnv ? [activePythonEnv] : [])
                        });
                    });
                    test('Discover multiple global kernelspecs and a custom Python kernelspecs with env vars', async () => {
                        const testData: TestData = {
                            globalKernelSpecs: [
                                juliaKernelSpec,
                                javaKernelSpec,
                                fullyQualifiedPythonKernelSpec,
                                fullyQualifiedPythonKernelSpecWithEnv
                            ],
                            interpreters: [python38VenvEnv]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        await verifyKernels({
                            expectedGlobalKernelSpecs: [
                                juliaKernelSpec,
                                javaKernelSpec,
                                fullyQualifiedPythonKernelSpec,
                                fullyQualifiedPythonKernelSpecWithEnv
                            ],
                            expectedInterpreters: [python38VenvEnv].concat(activePythonEnv ? [activePythonEnv] : [])
                        });
                    });
                    test('If we do not have python extension installed, then ensure we do not start kernels using Python Environment, instead they are started as regular kernelspecs (via spawn)', async () => {
                        const testData: TestData = {
                            globalKernelSpecs: [
                                juliaKernelSpec,
                                javaKernelSpec,
                                fullyQualifiedPythonKernelSpecForGlobalPython36,
                                fullyQualifiedPythonKernelSpecForGlobalPython36WithCustomEnvVars,
                                fullyQualifiedPythonKernelSpec,
                                fullyQualifiedPythonKernelSpecWithEnv
                            ]
                        };
                        await initialize(testData, undefined);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(false);

                        await verifyKernels({
                            expectedGlobalKernelSpecs: [
                                juliaKernelSpec,
                                javaKernelSpec,
                                fullyQualifiedPythonKernelSpecForGlobalPython36,
                                fullyQualifiedPythonKernelSpecForGlobalPython36WithCustomEnvVars,
                                fullyQualifiedPythonKernelSpec,
                                fullyQualifiedPythonKernelSpecWithEnv
                            ]
                        });

                        // Nothing should be started using the Python interpreter.
                        // Why? Because we don't have the Python extension.
                        const actualKernels = await kernelFinder.listKernels(undefined);
                        assert.isUndefined(
                            actualKernels.find((kernel) => kernel.kind === 'startUsingPythonInterpreter')
                        );
                    });
                    test('Default Python kernlespecs should be ignored', async () => {
                        const testData: TestData = {
                            interpreters: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelSpecs: [defaultPython3Kernel]
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        const expectedKernels: ExpectedKernels = {
                            expectedInterpreters: [python39PyEnv_HelloWorld].concat(
                                activePythonEnv ? [activePythonEnv] : []
                            )
                        };

                        await verifyKernels(expectedKernels);
                    });
                    test('Custom Python Kernels with custom env variables are listed', async () => {
                        const testData: TestData = {
                            globalKernelSpecs: [juliaKernelSpec],
                            interpreters: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelSpecs: [
                                        defaultPython3Kernel,
                                        defaultPython3KernelWithEnvVars,
                                        customPythonKernelWithCustomArgv,
                                        customPythonKernelWithCustomEnv
                                    ]
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        const expectedKernels: ExpectedKernels = {
                            expectedGlobalKernelSpecs: [juliaKernelSpec],
                            expectedInterpreterKernelSpecFiles: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelspec: defaultPython3KernelWithEnvVars
                                },
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelspec: customPythonKernelWithCustomArgv
                                },
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelspec: customPythonKernelWithCustomEnv
                                }
                            ],
                            expectedInterpreters: [python39PyEnv_HelloWorld].concat(
                                activePythonEnv ? [activePythonEnv] : []
                            )
                        };

                        await verifyKernels(expectedKernels);
                    });
                    test('Multiple global & custom Python Kernels', async () => {
                        const testData: TestData = {
                            globalKernelSpecs: [juliaKernelSpec],
                            interpreters: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelSpecs: [
                                        defaultPython3Kernel,
                                        defaultPython3KernelWithEnvVars,
                                        customPythonKernelWithCustomArgv,
                                        customPythonKernelWithCustomEnv
                                    ]
                                },
                                python36Global,
                                {
                                    interpreter: python37Global,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: condaEnv1,
                                    kernelSpecs: [javaKernelSpec]
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        const expectedKernels: ExpectedKernels = {
                            expectedGlobalKernelSpecs: [juliaKernelSpec],
                            expectedInterpreterKernelSpecFiles: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelspec: defaultPython3KernelWithEnvVars
                                },
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelspec: customPythonKernelWithCustomArgv
                                },
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelspec: customPythonKernelWithCustomEnv
                                },
                                {
                                    interpreter: condaEnv1,
                                    kernelspec: javaKernelSpec
                                }
                            ],
                            expectedInterpreters: [
                                python39PyEnv_HelloWorld,
                                python36Global,
                                python37Global,
                                condaEnv1
                            ].concat(activePythonEnv ? [activePythonEnv] : [])
                        };

                        await verifyKernels(expectedKernels);
                    });
                    test('Can match based on notebook metadata', async () => {
                        const testData: TestData = {
                            globalKernelSpecs: [juliaKernelSpec, rKernelSpec, rV1KernelSpec, python2spec],
                            interpreters: [
                                {
                                    interpreter: python36Global,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelSpecs: [
                                        defaultPython3Kernel,
                                        defaultPython3KernelWithEnvVars,
                                        customPythonKernelWithCustomArgv,
                                        customPythonKernelWithCustomEnv
                                    ]
                                },
                                {
                                    interpreter: python37Global,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: condaEnv1,
                                    kernelSpecs: [javaKernelSpec]
                                },
                                {
                                    interpreter: python38PyEnv_temp1,
                                    kernelSpecs: [defaultPython3Kernel, customPythonKernelWithCustomEnv]
                                },
                                {
                                    interpreter: python38PyEnv_temp2_duplicateNameAsTemp1,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: python38PyEnv_temp3_duplicateNameAsTemp1,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: python38PyEnv_temp4_duplicateNameAsTemp1ButNoBin,
                                    kernelSpecs: [defaultPython3Kernel, customPythonKernelWithCustomEnv]
                                },
                                {
                                    interpreter: duplicate1OfPython38PyEnv_temp1
                                },
                                {
                                    interpreter: python2Global
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);
                        const nbUri = Uri.file('test.ipynb');
                        let kernel: KernelConnectionMetadata | undefined;

                        // Try an empty python Notebook without any kernelspec in metadata.
                        kernel = await kernelFinder.findKernel(nbUri, {
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        assert.equal(kernel?.kernelSpec?.language, 'python');
                        assert.strictEqual(kernel?.kind, 'startUsingPythonInterpreter');
                        assert.notStrictEqual(
                            getKernelRegistrationInfo(kernel!.kernelSpec),
                            'registeredByNewVersionOfExtForCustomKernelSpec'
                        );
                        if (activePythonEnv) {
                            await verifyKernel(kernel, { expectedInterpreter: activePythonEnv });
                        }

                        // Generic Python 3 notebooks.
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: 'Python 3',
                                name: 'python3'
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        assert.equal(kernel?.kernelSpec?.language, 'python');
                        assert.strictEqual(kernel?.kind, 'startUsingPythonInterpreter');
                        assert.notStrictEqual(
                            getKernelRegistrationInfo(kernel!.kernelSpec),
                            'registeredByNewVersionOfExtForCustomKernelSpec'
                        );
                        if (activePythonEnv && activePythonEnv.version?.major && activePythonEnv.version?.major >= 3) {
                            await verifyKernel(kernel, { expectedInterpreter: activePythonEnv });
                        }

                        // Generic Python 3 notebooks (kernels with IpyKernel installed).
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: 'Python 3 (IPyKernel)',
                                name: 'python3'
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        assert.equal(kernel?.kernelSpec?.language, 'python');
                        assert.strictEqual(kernel?.kind, 'startUsingPythonInterpreter');
                        assert.notStrictEqual(
                            getKernelRegistrationInfo(kernel!.kernelSpec),
                            'registeredByNewVersionOfExtForCustomKernelSpec'
                        );
                        if (activePythonEnv && activePythonEnv.version?.major && activePythonEnv.version?.major >= 3) {
                            await verifyKernel(kernel, { expectedInterpreter: activePythonEnv });
                        }

                        // Python 2
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: 'Python 2 on Disk',
                                name: 'python2'
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        assert.equal(kernel?.kernelSpec?.display_name, 'Python 2 on Disk');
                        assert.equal(kernel?.kernelSpec?.language, 'python');
                        assert.strictEqual(kernel?.kind, 'startUsingLocalKernelSpec');
                        assert.notStrictEqual(
                            getKernelRegistrationInfo(kernel!.kernelSpec),
                            'registeredByNewVersionOfExtForCustomKernelSpec'
                        );
                        await verifyKernel(kernel, {
                            expectedGlobalKernelSpec: python2spec,
                            expectedInterpreter: python2Global
                        });

                        // Julia based on language
                        kernel = await kernelFinder.findKernel(nbUri, {
                            language_info: { name: 'julia' },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedGlobalKernelSpec: juliaKernelSpec });

                        // Julia based on kernelspec name & display name (without any language information)
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: juliaKernelSpec.display_name,
                                name: juliaKernelSpec.name
                            },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedGlobalKernelSpec: juliaKernelSpec });

                        // R (match a specific R kernel based on the display name & name)
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: rV1KernelSpec.display_name,
                                name: rV1KernelSpec.name
                            },
                            language_info: { name: 'r' },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedGlobalKernelSpec: rV1KernelSpec });

                        // R (match a specific R kernel based on the name)
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: '',
                                name: rV1KernelSpec.name
                            },
                            language_info: { name: 'r' },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedGlobalKernelSpec: rV1KernelSpec });

                        // R (match a specific R kernel based on the display_name)
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: rV1KernelSpec.display_name,
                                name: ''
                            },
                            language_info: { name: 'r' },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedGlobalKernelSpec: rV1KernelSpec });

                        // Python 2 based on name
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: 'Some unknown name for Python 2',
                                name: 'python2'
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedInterpreter: python2Global });

                        // Python 2 based on display name
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: python2Global.displayName || '',
                                name: 'python2'
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedInterpreter: python2Global });

                        // Match conda environment based on env display name of conda env.
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: '',
                                name: condaEnv1.envName || ''
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedInterpreter: condaEnv1 });

                        // Match conda environment based on env display name of conda env.
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: condaEnv1.displayName || '',
                                name: condaEnv1.envName || ''
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedInterpreter: condaEnv1 });

                        // Match conda environment based on env name of conda env (even if name doesn't match).
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: condaEnv1.displayName || '',
                                name: 'someUnknownNameThatWillNeverMatch'
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedInterpreter: condaEnv1 });

                        // Match based on interpreter hash even if name and display name do not match.
                        kernel = await kernelFinder.findKernel(nbUri, {
                            kernelspec: {
                                display_name: 'Will never match',
                                name: 'someUnknownNameThatWillNeverMatch'
                            },
                            interpreter: {
                                hash: getInterpreterHash(condaEnv1)
                            },
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        await verifyKernel(kernel, { expectedInterpreter: condaEnv1 });

                        // Unknown kernel language
                        kernel = await kernelFinder.findKernel(nbUri, {
                            language_info: { name: 'someunknownlanguage' },
                            orig_nbformat: 4
                        });
                        assert.isUndefined(kernel, 'Should not return a kernel');
                    });
                    test('Return active interpreter for interactive window', async function () {
                        if (!activePythonEnv) {
                            return this.skip();
                        }
                        const testData: TestData = {
                            globalKernelSpecs: [juliaKernelSpec],
                            interpreters: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelSpecs: [
                                        defaultPython3Kernel,
                                        defaultPython3KernelWithEnvVars,
                                        customPythonKernelWithCustomArgv,
                                        customPythonKernelWithCustomEnv
                                    ]
                                },
                                python36Global,
                                {
                                    interpreter: python37Global,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: condaEnv1,
                                    kernelSpecs: [javaKernelSpec]
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        const kernel = await kernelFinder.findKernel(Uri.file('wow.py'), {
                            language_info: { name: PYTHON_LANGUAGE },
                            orig_nbformat: 4
                        });
                        assert.strictEqual(
                            kernel?.kernelSpec?.language,
                            'python',
                            'No python kernel found matching notebook metadata'
                        );
                        // Verify the kernel points to the active interpreter.
                        assert.strictEqual(kernel?.kind, 'startUsingPythonInterpreter');
                        assert.deepEqual(kernel?.interpreter, activePythonEnv);
                    });
                    test('Return active interpreter for interactive window (without passing any metadata)', async function () {
                        if (!activePythonEnv) {
                            return this.skip();
                        }
                        const testData: TestData = {
                            globalKernelSpecs: [juliaKernelSpec],
                            interpreters: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelSpecs: [
                                        defaultPython3Kernel,
                                        defaultPython3KernelWithEnvVars,
                                        customPythonKernelWithCustomArgv,
                                        customPythonKernelWithCustomEnv
                                    ]
                                },
                                python36Global,
                                {
                                    interpreter: python37Global,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: condaEnv1,
                                    kernelSpecs: [javaKernelSpec]
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        const kernel = await kernelFinder.findKernel(Uri.file('wow.py'));
                        assert.strictEqual(
                            kernel?.kernelSpec?.language,
                            'python',
                            'No python kernel found matching notebook metadata'
                        );
                        // Verify the kernel points to the active interpreter.
                        assert.strictEqual(kernel?.kind, 'startUsingPythonInterpreter');
                        assert.deepEqual(kernel?.interpreter, activePythonEnv);
                    });
                    test('Return active interpreter for interactive window (metadata only has language)', async function () {
                        if (!activePythonEnv) {
                            return this.skip();
                        }
                        const testData: TestData = {
                            globalKernelSpecs: [juliaKernelSpec],
                            interpreters: [
                                {
                                    interpreter: python39PyEnv_HelloWorld,
                                    kernelSpecs: [
                                        defaultPython3Kernel,
                                        defaultPython3KernelWithEnvVars,
                                        customPythonKernelWithCustomArgv,
                                        customPythonKernelWithCustomEnv
                                    ]
                                },
                                python36Global,
                                {
                                    interpreter: python37Global,
                                    kernelSpecs: [defaultPython3Kernel]
                                },
                                {
                                    interpreter: condaEnv1,
                                    kernelSpecs: [javaKernelSpec]
                                }
                            ]
                        };
                        await initialize(testData, activePythonEnv);
                        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);

                        const kernel = await kernelFinder.findKernel(Uri.file('wow.py'), {
                            language_info: {
                                name: PYTHON_LANGUAGE
                            }
                        } as any);
                        assert.strictEqual(
                            kernel?.kernelSpec?.language,
                            'python',
                            'No python kernel found matching notebook metadata'
                        );
                        // Verify the kernel points to the active interpreter.
                        assert.strictEqual(kernel?.kind, 'startUsingPythonInterpreter');
                        assert.deepEqual(kernel?.interpreter, activePythonEnv);
                    });
                }
            );
        });
    });
});
