// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as nodepath from 'path';
import { Uri, WorkspaceFolder } from 'vscode';
import { getOSType, OSType } from '../utils/platform';
import { IExecutables, IFileSystemPaths, IFileSystemPathUtils } from './types';
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const untildify = require('untildify');

export const homePath = untildify('~');

// The parts of node's 'path' module used by FileSystemPaths.
interface INodePath {
    sep: string;
    join(...filenames: string[]): string;
    dirname(filename: string): string;
    basename(filename: string, ext?: string): string;
    normalize(filename: string): string;
}

export class FileSystemPaths implements IFileSystemPaths {
    constructor(
        // "true" if targeting a case-insensitive host (like Windows)
        private readonly isCaseInsensitive: boolean,
        // (effectively) the node "path" module to use
        private readonly raw: INodePath
    ) {}
    // Create a new object using common-case default values.
    // We do not use an alternate constructor because defaults in the
    // constructor runs counter to our typical approach.
    public static withDefaults(
        // default: use "isWindows"
        isCaseInsensitive?: boolean
    ): FileSystemPaths {
        if (isCaseInsensitive === undefined) {
            isCaseInsensitive = getOSType() === OSType.Windows;
        }
        return new FileSystemPaths(
            isCaseInsensitive,
            // Use the actual node "path" module.
            nodepath
        );
    }

    public get sep(): string {
        return this.raw.sep;
    }

    public join(...filenames: string[]): string {
        return this.raw.join(...filenames);
    }

    public dirname(filename: string): string {
        return this.raw.dirname(filename);
    }

    public basename(filename: string, suffix?: string): string {
        return this.raw.basename(filename, suffix);
    }

    public normalize(filename: string): string {
        return this.raw.normalize(filename);
    }

    public normCase(filename: string): string {
        filename = this.raw.normalize(filename);
        return this.isCaseInsensitive ? filename.toUpperCase() : filename;
    }
}

export class Executables {
    constructor(
        // the $PATH delimiter to use
        public readonly delimiter: string,
        // the OS type to target
        private readonly osType: OSType
    ) {}
    // Create a new object using common-case default values.
    // We do not use an alternate constructor because defaults in the
    // constructor runs counter to our typical approach.
    public static withDefaults(): Executables {
        return new Executables(
            // Use node's value.
            nodepath.delimiter,
            // Use the current OS.
            getOSType()
        );
    }

    public get envVar(): string {
        return this.osType === OSType.Windows ? 'Path' : 'PATH';
    }
}

// The dependencies FileSystemPathUtils has on node's path module.
interface IRawPaths {
    relative(relpath: string, rootpath: string): string;
}

export class FileSystemPathUtils implements IFileSystemPathUtils {
    constructor(
        // the user home directory to use (and expose)
        public readonly home: string,
        // the low-level FS path operations to use (and expose)
        public readonly paths: IFileSystemPaths,
        // the low-level OS "executables" to use (and expose)
        public readonly executables: IExecutables,
        // other low-level FS path operations to use
        private readonly raw: IRawPaths
    ) {}
    // Create a new object using common-case default values.
    // We do not use an alternate constructor because defaults in the
    // constructor runs counter to our typical approach.
    public static withDefaults(
        // default: a new FileSystemPaths object (using defaults)
        paths?: IFileSystemPaths
    ): FileSystemPathUtils {
        if (paths === undefined) {
            paths = FileSystemPaths.withDefaults();
        }
        return new FileSystemPathUtils(
            // Use the current user's home directory.
            homePath,
            paths,
            Executables.withDefaults(),
            // Use the actual node "path" module.
            nodepath
        );
    }

    public arePathsSame(path1: string, path2: string): boolean {
        path1 = this.paths.normCase(path1);
        path2 = this.paths.normCase(path2);
        return path1 === path2;
    }

    public getDisplayName(filename: string, cwd?: string): string {
        if (cwd && filename.startsWith(cwd)) {
            return `.${this.paths.sep}${this.raw.relative(cwd, filename)}`;
        } else if (filename.startsWith(this.home)) {
            return `~${this.paths.sep}${this.raw.relative(this.home, filename)}`;
        } else {
            return filename;
        }
    }
}
export function getDisplayPath(
    filename?: string | Uri,
    workspaceFolders: readonly WorkspaceFolder[] | WorkspaceFolder[] = []
) {
    const relativeToHome = getDisplayPathImpl(filename);
    const relativeToWorkspaceFolders = workspaceFolders.map((folder) =>
        getDisplayPathImpl(filename, folder.uri.fsPath)
    );
    // Pick the shortest path for display purposes.
    // As those are most likely relative to some workspace folder.
    let bestDisplayPath = relativeToHome;
    [relativeToHome, ...relativeToWorkspaceFolders].forEach((relativePath) => {
        if (relativePath.length < bestDisplayPath.length) {
            bestDisplayPath = relativePath;
        }
    });

    return bestDisplayPath;
}

function getDisplayPathImpl(filename?: string | Uri, cwd?: string): string {
    let file = '';
    if (typeof filename === 'string') {
        file = filename;
    } else if (!filename) {
        file = '';
    } else if (filename.scheme === 'file') {
        file = filename.fsPath;
    } else {
        file = filename.toString();
    }
    if (!file) {
        return '';
    } else if (cwd && file.startsWith(cwd)) {
        const relativePath = `.${nodepath.sep}${nodepath.relative(cwd, file)}`;
        // On CI the relative path might not work as expected as when testing we might have windows paths
        // and the code is running on a unix machine.
        return relativePath === file || relativePath.includes(cwd)
            ? `.${nodepath.sep}${file.substring(file.indexOf(cwd) + cwd.length)}`
            : relativePath;
    } else if (file.startsWith(homePath)) {
        return `~${nodepath.sep}${nodepath.relative(homePath, file)}`;
    } else {
        return file;
    }
}
