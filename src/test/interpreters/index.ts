// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import '../../platform/common/extensions';
import { traceError } from '../../platform/logging';
import { BufferDecoder } from '../../platform/common/process/decoder.node';
import { PythonEnvInfo } from '../../platform/common/process/internal/scripts/index.node';
import { ProcessService } from '../../platform/common/process/proc.node';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { parsePythonVersion } from '../../platform/pythonEnvironments/info/pythonVersion';
import { getOSType, OSType } from '../common';
import { EXTENSION_ROOT_DIR_FOR_TESTS } from '../constants';
import { isCondaEnvironment } from './condaLocator';
import { getCondaEnvironment, getCondaFile, isCondaAvailable } from './condaService';

const executionTimeout = 30_000;
const SCRIPTS_DIR = path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'pythonFiles');
const defaultShells = {
    [OSType.Windows]: 'cmd',
    [OSType.OSX]: 'bash',
    [OSType.Linux]: 'bash',
    [OSType.Unknown]: undefined
};

const defaultShell = defaultShells[getOSType()];

const interpreterInfoCache = new Map<string, Promise<PythonEnvironment | undefined>>();
export async function getInterpreterInfo(pythonPath: string | undefined): Promise<PythonEnvironment | undefined> {
    if (!pythonPath) {
        return undefined;
    }
    if (interpreterInfoCache.has(pythonPath)) {
        return interpreterInfoCache.get(pythonPath);
    }

    const promise = (async () => {
        try {
            const cli = await getPythonCli(pythonPath);
            const processService = new ProcessService(new BufferDecoder());
            const argv = [...cli, path.join(SCRIPTS_DIR, 'interpreterInfo.py').fileToCommandArgument()];
            const cmd = argv.reduce((p, c) => (p ? `${p} "${c}"` : `"${c.replace('\\', '/')}"`), '');
            const result = await processService.shellExec(cmd, {
                timeout: executionTimeout,
                env: process.env,
                shell: defaultShell
            });
            if (result.stderr && result.stderr.length) {
                traceError(`Failed to parse interpreter information for ${argv} stderr: ${result.stderr}`);
                return;
            }
            const json: PythonEnvInfo = JSON.parse(result.stdout.trim());
            const rawVersion = `${json.versionInfo.slice(0, 3).join('.')}-${json.versionInfo[3]}`;
            return {
                path: json.exe,
                displayName: `Python${rawVersion}`,
                version: parsePythonVersion(rawVersion),
                sysVersion: json.sysVersion,
                sysPrefix: json.sysPrefix
            };
        } catch (ex) {
            traceError('Failed to get Activated env Variables: ', ex);
            return undefined;
        }
    })();
    interpreterInfoCache.set(pythonPath, promise);
    return promise;
}

const envVariables = new Map<string, Promise<NodeJS.ProcessEnv | undefined>>();
export async function getActivatedEnvVariables(pythonPath: string): Promise<NodeJS.ProcessEnv | undefined> {
    if (envVariables.has(pythonPath)) {
        return envVariables.get(pythonPath);
    }
    const promise = (async () => {
        const cli = await getPythonCli(pythonPath);
        const processService = new ProcessService(new BufferDecoder());
        const separator = 'e976ee50-99ed-4aba-9b6b-9dcd5634d07d';
        const argv = [...cli, path.join(SCRIPTS_DIR, 'printEnvVariables.py')];
        const cmd = argv.reduce((p, c) => (p ? `${p} "${c}"` : `"${c.replace('\\', '/')}"`), '');
        const result = await processService.shellExec(cmd, {
            timeout: executionTimeout,
            maxBuffer: 1000 * 1000,
            throwOnStdErr: false,
            env: process.env,
            shell: defaultShell
        });
        if (result.stderr && result.stderr.length) {
            traceError(`Failed to parse interpreter information for ${argv} stderr: ${result.stderr}`);
            return;
        }
        try {
            // Sometimes when environments get activated, we get a lot of noise in the output.
            // Having a separator allows us to filter out the noise.
            const output = result.stdout;
            return JSON.parse(output.substring(output.indexOf(separator) + separator.length).trim());
        } catch (ex) {
            traceError(`Failed to parse interpreter information for ${argv}`, ex);
        }
    })();
    envVariables.set(pythonPath, promise);
    return promise;
}

async function getPythonCli(pythonPath: string | undefined) {
    const isConda = await isCondaEnvironment(pythonPath);
    if (isConda) {
        try {
            const available = isCondaAvailable();
            if (!available) {
                throw new Error('No conda but using conda interpreter');
            }
            const condaInfo = await getCondaEnvironment(pythonPath);
            const runArgs = ['run'];
            if (!condaInfo) {
                throw new Error('No conda info');
            } else if (condaInfo.name === '') {
                runArgs.push('-p', condaInfo.path);
            } else {
                runArgs.push('-n', condaInfo.name);
            }

            const condaFile = await getCondaFile();
            return [condaFile.fileToCommandArgument(), ...runArgs, 'python'];
        } catch {
            // Noop.
        }
        traceError('Using Conda Interpreter, but no conda');
    }
    return pythonPath ? [pythonPath.fileToCommandArgument()] : [];
}
