// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { sendTelemetryEvent } from '../../../telemetry';
import { EventName } from '../../../telemetry/constants';
import { traceError } from '../../logging';
import { isFileNotFoundError } from '../platform/errors.node';
import { IFileSystem } from '../platform/types.node';
import { EnvironmentVariables, IEnvironmentVariablesService } from './types';

@injectable()
export class EnvironmentVariablesService implements IEnvironmentVariablesService {
    constructor(@inject(IFileSystem) private readonly fs: IFileSystem) {}

    public async parseFile(
        filePath?: string,
        baseVars?: EnvironmentVariables
    ): Promise<EnvironmentVariables | undefined> {
        if (!filePath) {
            return;
        }
        try {
            return parseEnvFile(await this.fs.readLocalFile(filePath), baseVars);
        } catch (ex) {
            if (!isFileNotFoundError(ex)) {
                traceError(`Failed to parse env file ${filePath}`, ex);
            }
        }
    }

    public mergeVariables(source: EnvironmentVariables, target: EnvironmentVariables) {
        if (!target) {
            return;
        }
        Object.keys(source).forEach((setting) => {
            const lowerCase = setting.toLowerCase();
            if (lowerCase == 'pythonpath' || lowerCase == 'path') {
                // PATH can be path, Path, or PATH on the same OS depending
                // upon the source so check all cases.
                return;
            }
            const targetSetting = Object.keys(target).find((k) => k.toLowerCase() === lowerCase) || setting;
            target[targetSetting] = source[setting];
        });
    }

    public mergePaths(source: EnvironmentVariables, target: EnvironmentVariables) {
        // Figure out path key for both
        const sourcePathKey = Object.keys(source).find((k) => k.toLowerCase() === 'path');
        const targetPathKey = Object.keys(target).find((k) => k.toLowerCase() === 'path') || sourcePathKey;

        // Update the path on the target to match the source
        if (sourcePathKey && targetPathKey) {
            target[targetPathKey] = source[sourcePathKey];
        }
    }

    public appendPythonPath(vars: EnvironmentVariables, ...pythonPaths: string[]) {
        return this.appendPaths(vars, 'PYTHONPATH', true, ...pythonPaths);
    }

    public appendPath(vars: EnvironmentVariables, ...paths: string[]) {
        return this.appendPaths(vars, 'PATH', true, ...paths);
    }

    public prependPath(vars: EnvironmentVariables, ...paths: string[]) {
        return this.appendPaths(vars, 'PATH', false, ...paths);
    }

    private appendPaths(
        vars: EnvironmentVariables,
        variableName: 'PATH' | 'PYTHONPATH',
        append: boolean,
        ...pathsToAppend: string[]
    ) {
        const valueToAppendOrPrepend = pathsToAppend
            .filter((item) => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim())
            .join(path.delimiter);
        if (valueToAppendOrPrepend.length === 0) {
            return vars;
        }

        // It's been shown that the 'path' variable can have multiple casing even on the same platform
        // depending upon where the environment variable comes from (kernelspec might have 'PATH' whereas windows might use 'Path')
        const variableNameLower = variableName.toLowerCase();
        const matchingKey = vars ? Object.keys(vars).find((k) => k.toLowerCase() == variableNameLower) : undefined;
        const variable = vars && matchingKey ? vars[matchingKey] : undefined;
        const setKey = matchingKey || variableName;
        if (variable && typeof variable === 'string' && variable.length > 0) {
            if (append) {
                vars[setKey] = variable + path.delimiter + valueToAppendOrPrepend;
            } else {
                vars[setKey] = valueToAppendOrPrepend + path.delimiter + variable;
            }
        } else {
            vars[setKey] = valueToAppendOrPrepend;
        }
        return vars;
    }
}

export function parseEnvFile(lines: string | Buffer, baseVars?: EnvironmentVariables): EnvironmentVariables {
    const globalVars = baseVars ? baseVars : {};
    const vars: EnvironmentVariables = {};
    lines
        .toString()
        .split('\n')
        .forEach((line, _idx) => {
            const [name, value] = parseEnvLine(line);
            if (name === '') {
                return;
            }
            vars[name] = substituteEnvVars(value, vars, globalVars);
        });
    return vars;
}

function parseEnvLine(line: string): [string, string] {
    // Most of the following is an adaptation of the dotenv code:
    //   https://github.com/motdotla/dotenv/blob/master/lib/main.js#L32
    // We don't use dotenv here because it loses ordering, which is
    // significant for substitution.
    const match = line.match(/^\s*([a-zA-Z]\w*)\s*=\s*(.*?)?\s*$/);
    if (!match) {
        return ['', ''];
    }

    const name = match[1];
    let value = match[2];
    if (value && value !== '') {
        if (value[0] === "'" && value[value.length - 1] === "'") {
            value = value.substring(1, value.length - 1);
            value = value.replace(/\\n/gm, '\n');
        } else if (value[0] === '"' && value[value.length - 1] === '"') {
            value = value.substring(1, value.length - 1);
            value = value.replace(/\\n/gm, '\n');
        }
    } else {
        value = '';
    }

    return [name, value];
}

const SUBST_REGEX = /\${([a-zA-Z]\w*)?([^}\w].*)?}/g;

function substituteEnvVars(
    value: string,
    localVars: EnvironmentVariables,
    globalVars: EnvironmentVariables,
    missing = ''
): string {
    // Substitution here is inspired a little by dotenv-expand:
    //   https://github.com/motdotla/dotenv-expand/blob/master/lib/main.js

    let invalid = false;
    let replacement = value;
    replacement = replacement.replace(SUBST_REGEX, (match, substName, bogus, offset, orig) => {
        if (offset > 0 && orig[offset - 1] === '\\') {
            return match;
        }
        if ((bogus && bogus !== '') || !substName || substName === '') {
            invalid = true;
            return match;
        }
        return localVars[substName] || globalVars[substName] || missing;
    });
    if (!invalid && replacement !== value) {
        value = replacement;
        sendTelemetryEvent(EventName.ENVFILE_VARIABLE_SUBSTITUTION);
    }

    return value.replace(/\\\$/g, '$');
}
