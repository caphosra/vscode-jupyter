// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

/* eslint-disable  */

import { createHash } from 'crypto';
import * as fs from 'fs-extra';
import { ReadStream, WriteStream } from 'fs-extra';
import * as glob from 'glob';
import { promisify } from 'util';
import * as vscode from 'vscode';
import '../extensions';
import { traceError } from '../../logging';
import { createDirNotEmptyError, isFileExistsError, isFileNotFoundError, isNoPermissionsError } from './errors.node';
import { FileSystemPaths, FileSystemPathUtils } from './fs-paths.node';
import { TemporaryFileSystem } from './fs-temp.node';
import { IFileSystemPaths, IFileSystemPathUtils, ITempFileSystem } from './types';
import { IRawFileSystem } from './types.node';

const ENCODING = 'utf8';

// This helper function determines the file type of the given stats
// object.  The type follows the convention of node's fs module, where
// a file has exactly one type.  Symlinks are not resolved.
export function convertFileType(stat: fs.Stats): vscode.FileType {
    if (stat.isFile()) {
        return vscode.FileType.File;
    } else if (stat.isDirectory()) {
        return vscode.FileType.Directory;
    } else if (stat.isSymbolicLink()) {
        // The caller is responsible for combining this ("logical or")
        // with File or Directory as necessary.
        return vscode.FileType.SymbolicLink;
    } else {
        return vscode.FileType.Unknown;
    }
}

export function convertStat(old: fs.Stats, filetype: vscode.FileType): vscode.FileStat {
    return {
        type: filetype,
        size: old.size,
        // FileStat.ctime and FileStat.mtime only have 1-millisecond
        // resolution, while node provides nanosecond resolution.  So
        // for now we round to the nearest integer.
        // See: https://github.com/microsoft/vscode/issues/84526
        ctime: Math.round(old.ctimeMs),
        mtime: Math.round(old.mtimeMs)
    };
}

function filterByFileType(
    files: [string, vscode.FileType][], // the files to filter
    fileType: vscode.FileType // the file type to look for
): [string, vscode.FileType][] {
    // We preserve the pre-existing behavior of following symlinks.
    if (fileType === vscode.FileType.Unknown) {
        // FileType.Unknown == 0 so we can't just use bitwise
        // operations blindly here.
        return files.filter(([_file, ft]) => {
            return ft === vscode.FileType.Unknown || ft === (vscode.FileType.SymbolicLink & vscode.FileType.Unknown);
        });
    } else {
        return files.filter(([_file, ft]) => (ft & fileType) > 0);
    }
}

//==========================================
// "raw" filesystem

// This is the parts of the vscode.workspace.fs API that we use here.
// See: https://code.visualstudio.com/api/references/vscode-api#FileSystem
// Note that we have used all the API functions *except* "rename()".
interface IVSCodeFileSystemAPI {
    copy(source: vscode.Uri, target: vscode.Uri, options?: { overwrite: boolean }): Thenable<void>;
    createDirectory(uri: vscode.Uri): Thenable<void>;
    delete(uri: vscode.Uri, options?: { recursive: boolean; useTrash: boolean }): Thenable<void>;
    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]>;
    readFile(uri: vscode.Uri): Thenable<Uint8Array>;
    rename(source: vscode.Uri, target: vscode.Uri, options?: { overwrite: boolean }): Thenable<void>;
    stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
    writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
}

// This is the parts of the 'fs-extra' module that we use in RawFileSystem.
interface IRawFSExtra {
    lstat(filename: string): Promise<fs.Stats>;
    chmod(filePath: string, mode: string | number): Promise<void>;
    appendFile(filename: string, data: {}): Promise<void>;

    // non-async
    lstatSync(filename: string): fs.Stats;
    statSync(filename: string): fs.Stats;
    readFileSync(path: string, encoding: string): string;
    createReadStream(filename: string): ReadStream;
    createWriteStream(filename: string): WriteStream;
}

interface IRawPath {
    dirname(path: string): string;
    join(...paths: string[]): string;
}

// Later we will drop "FileSystem", switching usage to
// "FileSystemUtils" and then rename "RawFileSystem" to "FileSystem".

// The low-level filesystem operations used by the extension.
export class RawFileSystem implements IRawFileSystem {
    constructor(
        // the low-level FS path operations to use
        protected readonly paths: IRawPath,
        // the VS Code FS API to use
        protected readonly vscfs: IVSCodeFileSystemAPI,
        // the node FS API to use
        protected readonly fsExtra: IRawFSExtra
    ) {}

    // Create a new object using common-case default values.
    public static withDefaults(
        paths?: IRawPath, // default: a new FileSystemPaths object (using defaults)
        vscfs?: IVSCodeFileSystemAPI, // default: the actual "vscode.workspace.fs" namespace
        fsExtra?: IRawFSExtra // default: the "fs-extra" module
    ): RawFileSystem {
        return new RawFileSystem(
            paths || FileSystemPaths.withDefaults(),
            vscfs || vscode.workspace.fs,
            // The "fs-extra" module is effectively equivalent to node's "fs"
            // module (but is a bit more async-friendly).  So we use that
            // instead of "fs".
            (fsExtra || fs) as any
        );
    }

    public async stat(filename: string): Promise<vscode.FileStat> {
        // Note that, prior to the November release of VS Code,
        // stat.ctime was always 0.
        // See: https://github.com/microsoft/vscode/issues/84525
        const uri = vscode.Uri.file(filename);
        return this.vscfs.stat(uri);
    }

    public async lstat(filename: string): Promise<vscode.FileStat> {
        // TODO https://github.com/microsoft/vscode/issues/71204 (84514)):
        //   This functionality has been requested for the VS Code API.
        const stat = await this.fsExtra.lstat(filename);
        // Note that, unlike stat(), lstat() does not include the type
        // of the symlink's target.
        const fileType = convertFileType(stat);
        return convertStat(stat, fileType);
    }

    public async chmod(filename: string, mode: string | number): Promise<void> {
        // TODO (https://github.com/microsoft/vscode/issues/73122 (84513)):
        //   This functionality has been requested for the VS Code API.
        return this.fsExtra.chmod(filename, mode);
    }

    public async move(src: string, tgt: string): Promise<void> {
        const srcUri = vscode.Uri.file(src);
        const tgtUri = vscode.Uri.file(tgt);
        // The VS Code API will automatically create the target parent
        // directory if it does not exist (even though the docs imply
        // otherwise).  So we have to manually stat, just to be sure.
        // Note that this behavior was reported, but won't be changing.
        // See: https://github.com/microsoft/vscode/issues/84177
        await this.vscfs.stat(vscode.Uri.file(this.paths.dirname(tgt)));
        // We stick with the pre-existing behavior where files are
        // overwritten and directories are not.
        const options = { overwrite: false };
        try {
            await this.vscfs.rename(srcUri, tgtUri, options);
        } catch (err) {
            if (!isFileExistsError(err)) {
                throw err; // re-throw
            }
            const stat = await this.vscfs.stat(tgtUri);
            if (stat.type === vscode.FileType.Directory) {
                throw err; // re-throw
            }
            options.overwrite = true;
            await this.vscfs.rename(srcUri, tgtUri, options);
        }
    }

    public async readData(filename: string): Promise<Buffer> {
        const uri = vscode.Uri.file(filename);
        const data = await this.vscfs.readFile(uri);
        return Buffer.from(data);
    }

    public async readText(filename: string): Promise<string> {
        const uri = vscode.Uri.file(filename);
        const result = await this.vscfs.readFile(uri);
        const data = Buffer.from(result);
        return data.toString(ENCODING);
    }

    public async writeText(filename: string, text: string): Promise<void> {
        const uri = vscode.Uri.file(filename);
        const data = Buffer.from(text);
        await this.vscfs.writeFile(uri, data);
    }

    public async appendText(filename: string, text: string): Promise<void> {
        // TODO: We *could* use the new API for this.
        // See https://github.com/microsoft/vscode-python/issues/9900
        return this.fsExtra.appendFile(filename, text);
    }

    public async copyFile(src: string, dest: string): Promise<void> {
        const srcURI = vscode.Uri.file(src);
        const destURI = vscode.Uri.file(dest);
        // The VS Code API will automatically create the target parent
        // directory if it does not exist (even though the docs imply
        // otherwise).  So we have to manually stat, just to be sure.
        // Note that this behavior was reported, but won't be changing.
        // See: https://github.com/microsoft/vscode/issues/84177
        await this.vscfs.stat(vscode.Uri.file(this.paths.dirname(dest)));
        await this.vscfs.copy(srcURI, destURI, {
            overwrite: true
        });
    }

    public async rmfile(filename: string): Promise<void> {
        const uri = vscode.Uri.file(filename);
        return this.vscfs.delete(uri, {
            recursive: false,
            useTrash: false
        });
    }

    public async rmdir(dirname: string): Promise<void> {
        const uri = vscode.Uri.file(dirname);
        // The "recursive" option disallows directories, even if they
        // are empty.  So we have to deal with this ourselves.
        const files = await this.vscfs.readDirectory(uri);
        if (files && files.length > 0) {
            throw createDirNotEmptyError(dirname);
        }
        return this.vscfs.delete(uri, {
            recursive: true,
            useTrash: false
        });
    }

    public async rmtree(dirname: string): Promise<void> {
        const uri = vscode.Uri.file(dirname);
        // TODO (https://github.com/microsoft/vscode/issues/84177):
        //   The docs say "throws - FileNotFound when uri doesn't exist".
        //   However, it happily does nothing.  So for now we have to
        //   manually stat, just to be sure.
        await this.vscfs.stat(uri);
        return this.vscfs.delete(uri, {
            recursive: true,
            useTrash: false
        });
    }

    public async mkdirp(dirname: string): Promise<void> {
        const uri = vscode.Uri.file(dirname);
        await this.vscfs.createDirectory(uri);
    }

    public async listdir(dirname: string): Promise<[string, vscode.FileType][]> {
        const uri = vscode.Uri.file(dirname);
        const files = await this.vscfs.readDirectory(uri);
        return files.map(([basename, filetype]) => {
            const filename = this.paths.join(dirname, basename);
            return [filename, filetype] as [string, vscode.FileType];
        });
    }

    //****************************
    // non-async

    // VS Code has decided to never support any sync functions (aside
    // from perhaps create*Stream()).
    // See: https://github.com/microsoft/vscode/issues/84518

    public statSync(filename: string): vscode.FileStat {
        // We follow the filetype behavior of the VS Code API, by
        // acknowledging symlinks.
        let stat = this.fsExtra.lstatSync(filename);
        let filetype = vscode.FileType.Unknown;
        if (stat.isSymbolicLink()) {
            filetype = vscode.FileType.SymbolicLink;
            stat = this.fsExtra.statSync(filename);
        }
        filetype |= convertFileType(stat);
        return convertStat(stat, filetype);
    }

    public readTextSync(filename: string): string {
        return this.fsExtra.readFileSync(filename, ENCODING);
    }

    public createReadStream(filename: string): ReadStream {
        // TODO (https://github.com/microsoft/vscode/issues/84515):
        //   This functionality has been requested for the VS Code API.
        return this.fsExtra.createReadStream(filename);
    }

    public createWriteStream(filename: string): WriteStream {
        // TODO (https://github.com/microsoft/vscode/issues/84515):
        //   This functionality has been requested for the VS Code API.
        return this.fsExtra.createWriteStream(filename);
    }
}

//==========================================
// filesystem "utils"

// High-level filesystem operations used by the extension.
export class FileSystemUtils {
    constructor(
        public readonly raw: IRawFileSystem,
        public readonly pathUtils: IFileSystemPathUtils,
        public readonly paths: IFileSystemPaths,
        public readonly tmp: ITempFileSystem,
        private readonly getHash: (data: string) => string,
        private readonly globFiles: (pat: string, options?: { cwd: string; dot?: boolean }) => Promise<string[]>
    ) {}
    // Create a new object using common-case default values.
    public static withDefaults(
        raw?: IRawFileSystem,
        pathUtils?: IFileSystemPathUtils,
        tmp?: ITempFileSystem,
        getHash?: (data: string) => string,
        globFiles?: (pat: string, options?: { cwd: string }) => Promise<string[]>
    ): FileSystemUtils {
        pathUtils = pathUtils || FileSystemPathUtils.withDefaults();
        return new FileSystemUtils(
            raw || RawFileSystem.withDefaults(pathUtils.paths),
            pathUtils,
            pathUtils.paths,
            tmp || TemporaryFileSystem.withDefaults(),
            getHash || getHashString,
            globFiles || promisify(glob)
        );
    }

    //****************************
    // aliases

    public async createDirectory(directoryPath: string): Promise<void> {
        return this.raw.mkdirp(directoryPath);
    }

    public async deleteDirectory(directoryPath: string): Promise<void> {
        return this.raw.rmdir(directoryPath);
    }

    public async deleteFile(filename: string): Promise<void> {
        return this.raw.rmfile(filename);
    }

    //****************************
    // helpers

    public async pathExists(
        // the "file" to look for
        filename: string,
        // the file type to expect; if not provided then any file type
        // matches; otherwise a mismatch results in a "false" value
        fileType?: vscode.FileType
    ): Promise<boolean> {
        let stat: vscode.FileStat;
        try {
            // Note that we are using stat() rather than lstat().  This
            // means that any symlinks are getting resolved.
            stat = await this.raw.stat(filename);
        } catch (err) {
            if (isFileNotFoundError(err)) {
                return false;
            }
            traceError(`stat() failed for "${filename}"`, err);
            return false;
        }

        if (fileType === undefined) {
            return true;
        }
        if (fileType === vscode.FileType.Unknown) {
            // FileType.Unknown == 0, hence do not use bitwise operations.
            return stat.type === vscode.FileType.Unknown;
        }
        return (stat.type & fileType) === fileType;
    }
    public async fileExists(filename: string): Promise<boolean> {
        return this.pathExists(filename, vscode.FileType.File);
    }
    public async directoryExists(dirname: string): Promise<boolean> {
        return this.pathExists(dirname, vscode.FileType.Directory);
    }

    public async listdir(dirname: string): Promise<[string, vscode.FileType][]> {
        try {
            return await this.raw.listdir(dirname);
        } catch (err) {
            // We're only preserving pre-existng behavior here...
            if (!(await this.pathExists(dirname))) {
                return [];
            }
            throw err; // re-throw
        }
    }
    public async getSubDirectories(dirname: string): Promise<string[]> {
        const files = await this.listdir(dirname);
        const filtered = filterByFileType(files, vscode.FileType.Directory);
        return filtered.map(([filename, _fileType]) => filename);
    }
    public async getFiles(dirname: string): Promise<string[]> {
        // Note that only "regular" files are returned.
        const files = await this.listdir(dirname);
        const filtered = filterByFileType(files, vscode.FileType.File);
        return filtered.map(([filename, _fileType]) => filename);
    }

    public async isDirReadonly(dirname: string): Promise<boolean> {
        const filePath = `${dirname}${this.paths.sep}___vscpTest___`;
        try {
            await this.raw.stat(dirname);
            await this.raw.writeText(filePath, '');
        } catch (err) {
            if (isNoPermissionsError(err)) {
                return true;
            }
            throw err; // re-throw
        }
        this.raw
            .rmfile(filePath)
            // Clean resources in the background.
            .ignoreErrors();
        return false;
    }

    public async getFileHash(filename: string): Promise<string> {
        // The reason for lstat rather than stat is not clear...
        const stat = await this.raw.lstat(filename);
        const data = `${stat.ctime}-${stat.mtime}`;
        return this.getHash(data);
    }

    public async search(globPattern: string, cwd?: string, dot?: boolean): Promise<string[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let options: any;
        if (cwd) {
            options = { ...options, cwd };
        }
        if (dot) {
            options = { ...options, dot };
        }

        const found = await this.globFiles(globPattern, options);
        return Array.isArray(found) ? found : [];
    }

    //****************************
    // helpers (non-async)

    public fileExistsSync(filePath: string): boolean {
        try {
            this.raw.statSync(filePath);
        } catch (err) {
            if (isFileNotFoundError(err)) {
                return false;
            }
            throw err; // re-throw
        }
        return true;
    }
}

// We *could* use ICryptoUtils, but it's a bit overkill, issue tracked
// in https://github.com/microsoft/vscode-python/issues/8438.
export function getHashString(data: string): string {
    const hash = createHash('sha512');
    hash.update(data);
    return hash.digest('hex');
}
