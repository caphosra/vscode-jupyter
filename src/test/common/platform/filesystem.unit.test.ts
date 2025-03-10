// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { expect } from 'chai';
import * as fs from 'fs';
import * as fsextra from 'fs-extra';
import * as TypeMoq from 'typemoq';
import * as vscode from 'vscode';
import { FileSystemUtils, RawFileSystem } from '../../../platform/common/platform/fileSystemUtils.node';
import {
    // These interfaces are needed for FileSystemUtils deps.
    IFileSystemPaths,
    IFileSystemPathUtils,
    ITempFileSystem
} from '../../../platform/common/platform/types';
import { IRawFileSystem } from '../../../platform/common/platform/types.node';

/* eslint-disable  */

function Uri(filename: string): vscode.Uri {
    return vscode.Uri.file(filename);
}

function createDummyStat(filetype: vscode.FileType): vscode.FileStat {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { type: filetype } as any;
}

function copyStat(stat: vscode.FileStat, old: TypeMoq.IMock<fsextra.Stats>) {
    old.setup((s) => s.size) // plug in the original value
        .returns(() => stat.size);
    old.setup((s) => s.ctimeMs) // plug in the original value
        .returns(() => stat.ctime);
    old.setup((s) => s.mtimeMs) // plug in the original value
        .returns(() => stat.mtime);
}

interface IPaths {
    // fs paths (IFileSystemPaths)
    sep: string;
    dirname(filename: string): string;
    join(...paths: string[]): string;
}

interface IRawFS extends IPaths {
    // vscode.workspace.fs
    copy(source: vscode.Uri, target: vscode.Uri, options?: { overwrite: boolean }): Thenable<void>;
    createDirectory(uri: vscode.Uri): Thenable<void>;
    delete(uri: vscode.Uri, options?: { recursive: boolean; useTrash: boolean }): Thenable<void>;
    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]>;
    readFile(uri: vscode.Uri): Thenable<Uint8Array>;
    rename(source: vscode.Uri, target: vscode.Uri, options?: { overwrite: boolean }): Thenable<void>;
    stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
    writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;

    // "fs-extra"
    lstat(filename: string): Promise<fs.Stats>;
    chmod(filePath: string, mode: string | number): Promise<void>;
    appendFile(filename: string, data: {}): Promise<void>;
    lstatSync(filename: string): fs.Stats;
    statSync(filename: string): fs.Stats;
    readFileSync(path: string, encoding: string): string;
    createReadStream(filename: string): fs.ReadStream;
    createWriteStream(filename: string): fs.WriteStream;
}

suite('Raw FileSystem', () => {
    let raw: TypeMoq.IMock<IRawFS>;
    let oldStats: TypeMoq.IMock<fs.Stats>[];
    let filesystem: RawFileSystem;
    setup(() => {
        raw = TypeMoq.Mock.ofType<IRawFS>(undefined, TypeMoq.MockBehavior.Strict);
        oldStats = [];
        filesystem = new RawFileSystem(
            // Since it's a mock we can just use it for all 3 values.
            raw.object,
            raw.object,
            raw.object
        );
    });
    function verifyAll() {
        raw.verifyAll();
        oldStats.forEach((stat) => {
            stat.verifyAll();
        });
    }
    function createMockLegacyStat(): TypeMoq.IMock<fsextra.Stats> {
        const stat = TypeMoq.Mock.ofType<fsextra.Stats>(undefined, TypeMoq.MockBehavior.Strict);
        // This is necessary because passing "mock.object" to
        // Promise.resolve() triggers the lookup.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stat.setup((s: any) => s.then)
            .returns(() => undefined)
            .verifiable(TypeMoq.Times.atLeast(0));
        oldStats.push(stat);
        return stat;
    }
    function setupStatFileType(stat: TypeMoq.IMock<fs.Stats>, filetype: vscode.FileType) {
        // This mirrors the logic in convertFileType().
        if (filetype === vscode.FileType.File) {
            stat.setup((s) => s.isFile())
                .returns(() => true)
                .verifiable(TypeMoq.Times.atLeastOnce());
        } else if (filetype === vscode.FileType.Directory) {
            stat.setup((s) => s.isFile())
                .returns(() => false)
                .verifiable(TypeMoq.Times.atLeastOnce());
            stat.setup((s) => s.isDirectory())
                .returns(() => true)
                .verifiable(TypeMoq.Times.atLeastOnce());
        } else if ((filetype & vscode.FileType.SymbolicLink) > 0) {
            stat.setup((s) => s.isFile())
                .returns(() => false)
                .verifiable(TypeMoq.Times.atLeastOnce());
            stat.setup((s) => s.isDirectory())
                .returns(() => false)
                .verifiable(TypeMoq.Times.atLeastOnce());
            stat.setup((s) => s.isSymbolicLink())
                .returns(() => true)
                .verifiable(TypeMoq.Times.atLeastOnce());
        } else if (filetype === vscode.FileType.Unknown) {
            stat.setup((s) => s.isFile())
                .returns(() => false)
                .verifiable(TypeMoq.Times.atLeastOnce());
            stat.setup((s) => s.isDirectory())
                .returns(() => false)
                .verifiable(TypeMoq.Times.atLeastOnce());
            stat.setup((s) => s.isSymbolicLink())
                .returns(() => false)
                .verifiable(TypeMoq.Times.atLeastOnce());
        } else {
            throw Error(`unsupported file type ${filetype}`);
        }
    }

    suite('stat', () => {
        test('wraps the low-level function', async () => {
            const filename = 'x/y/z/spam.py';
            const expected = createDummyStat(vscode.FileType.File);
            raw.setup((r) => r.stat(Uri(filename))) // expect the specific filename
                .returns(() => Promise.resolve(expected));

            const stat = await filesystem.stat(filename);

            expect(stat).to.equal(expected);
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.stat(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.stat('spam.py');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('lstat', () => {
        [
            { kind: 'file', filetype: vscode.FileType.File },
            { kind: 'dir', filetype: vscode.FileType.Directory },
            { kind: 'symlink', filetype: vscode.FileType.SymbolicLink },
            { kind: 'unknown', filetype: vscode.FileType.Unknown }
        ].forEach((testData) => {
            test(`wraps the low-level function (filetype: ${testData.kind}`, async () => {
                const filename = 'x/y/z/spam.py';
                const expected: vscode.FileStat = {
                    type: testData.filetype,
                    size: 10,
                    ctime: 101,
                    mtime: 102
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any;
                const old = createMockLegacyStat();
                setupStatFileType(old, testData.filetype);
                copyStat(expected, old);
                raw.setup((r) => r.lstat(filename)) // expect the specific filename
                    .returns(() => Promise.resolve(old.object));

                const stat = await filesystem.lstat(filename);

                expect(stat).to.deep.equal(expected);
                verifyAll();
            });
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.lstat(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.lstat('spam.py');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('chmod', () => {
        test('passes through a string mode', async () => {
            const filename = 'x/y/z/spam.py';
            const mode = '755';
            raw.setup((r) => r.chmod(filename, mode)) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.chmod(filename, mode);

            verifyAll();
        });

        test('passes through an int mode', async () => {
            const filename = 'x/y/z/spam.py';
            const mode = 0o755;
            raw.setup((r) => r.chmod(filename, mode)) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.chmod(filename, mode);

            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.chmod(TypeMoq.It.isAny(), TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.chmod('spam.py', 755);

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('move', () => {
        test('move a file (target does not exist)', async () => {
            const src = 'x/y/z/spam.py';
            const tgt = 'x/y/spam.py';
            raw.setup((r) => r.dirname(tgt)) // Provide the target's parent.
                .returns(() => 'x/y');
            raw.setup((r) => r.stat(Uri('x/y'))) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            raw.setup((r) => r.rename(Uri(src), Uri(tgt), { overwrite: false })) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.move(src, tgt);

            verifyAll();
        });

        test('move a file (target exists)', async () => {
            const src = 'x/y/z/spam.py';
            const tgt = 'x/y/spam.py';
            raw.setup((r) => r.dirname(tgt)) // Provide the target's parent.
                .returns(() => 'x/y');
            raw.setup((r) => r.stat(Uri('x/y'))) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            const err = vscode.FileSystemError.FileExists('...');
            raw.setup((r) => r.rename(Uri(src), Uri(tgt), { overwrite: false })) // expect the specific filename
                .returns(() => Promise.reject(err));
            raw.setup((r) => r.stat(Uri(tgt))) // It's a file.
                .returns(() => Promise.resolve({ type: vscode.FileType.File } as unknown as vscode.FileStat));
            raw.setup((r) => r.rename(Uri(src), Uri(tgt), { overwrite: true })) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.move(src, tgt);

            verifyAll();
        });

        test('move a directory (target does not exist)', async () => {
            const src = 'x/y/z/spam';
            const tgt = 'x/y/spam';
            raw.setup((r) => r.dirname(tgt)) // Provide the target's parent.
                .returns(() => 'x/y');
            raw.setup((r) => r.stat(Uri('x/y'))) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            raw.setup((r) => r.rename(Uri(src), Uri(tgt), { overwrite: false })) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.move(src, tgt);

            verifyAll();
        });

        test('moving a directory fails if target exists', async () => {
            const src = 'x/y/z/spam.py';
            const tgt = 'x/y/spam.py';
            raw.setup((r) => r.dirname(tgt)) // Provide the target's parent.
                .returns(() => 'x/y');
            raw.setup((r) => r.stat(Uri('x/y'))) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            const err = vscode.FileSystemError.FileExists('...');
            raw.setup((r) => r.rename(Uri(src), Uri(tgt), { overwrite: false })) // expect the specific filename
                .returns(() => Promise.reject(err));
            raw.setup((r) => r.stat(Uri(tgt))) // It's a directory.
                .returns(() => Promise.resolve({ type: vscode.FileType.Directory } as unknown as vscode.FileStat));

            const promise = filesystem.move(src, tgt);

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });

        test('move a symlink to a directory (target exists)', async () => {
            const src = 'x/y/z/spam';
            const tgt = 'x/y/spam.lnk';
            raw.setup((r) => r.dirname(tgt)) // Provide the target's parent.
                .returns(() => 'x/y');
            raw.setup((r) => r.stat(Uri('x/y'))) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            const err = vscode.FileSystemError.FileExists('...');
            raw.setup((r) => r.rename(Uri(src), Uri(tgt), { overwrite: false })) // expect the specific filename
                .returns(() => Promise.reject(err));
            raw.setup((r) => r.stat(Uri(tgt))) // It's a symlink.
                .returns(() =>
                    Promise.resolve({
                        type: vscode.FileType.SymbolicLink | vscode.FileType.Directory
                    } as unknown as vscode.FileStat)
                );
            raw.setup((r) => r.rename(Uri(src), Uri(tgt), { overwrite: true })) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.move(src, tgt);

            verifyAll();
        });

        test('fails if the target parent dir does not exist', async () => {
            raw.setup((r) => r.dirname(TypeMoq.It.isAny())) // Provide the target's parent.
                .returns(() => '');
            const err = vscode.FileSystemError.FileNotFound('...');
            raw.setup((r) => r.stat(TypeMoq.It.isAny())) // The parent dir does not exist.
                .returns(() => Promise.reject(err));

            const promise = filesystem.move('spam', 'eggs');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.dirname(TypeMoq.It.isAny())) // Provide the target's parent.
                .returns(() => '');
            raw.setup((r) => r.stat(TypeMoq.It.isAny())) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            const err = new Error('oops!');
            raw.setup((r) => r.rename(TypeMoq.It.isAny(), TypeMoq.It.isAny(), { overwrite: false })) // We don't care about the filename.
                .throws(err);

            const promise = filesystem.move('spam', 'eggs');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('readData', () => {
        test('wraps the low-level function', async () => {
            const filename = 'x/y/z/spam.py';
            const expected = Buffer.from('<data>');
            raw.setup((r) => r.readFile(Uri(filename))) // expect the specific filename
                .returns(() => Promise.resolve(expected));

            const data = await filesystem.readData(filename);

            expect(data).to.deep.equal(expected);
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.readFile(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.readData('spam.py');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('readText', () => {
        test('wraps the low-level function', async () => {
            const filename = 'x/y/z/spam.py';
            const expected = '<text>';
            const data = Buffer.from(expected);
            raw.setup((r) => r.readFile(Uri(filename))) // expect the specific filename
                .returns(() => Promise.resolve(data));

            const text = await filesystem.readText(filename);

            expect(text).to.equal(expected);
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.readFile(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.readText('spam.py');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('writeText', () => {
        test('wraps the low-level function', async () => {
            const filename = 'x/y/z/spam.py';
            const text = '<text>';
            const data = Buffer.from(text);
            raw.setup((r) => r.writeFile(Uri(filename), data)) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.writeText(filename, text);

            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.writeFile(TypeMoq.It.isAny(), TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.writeText('spam.py', '<text>');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('appendText', () => {
        test('wraps the low-level function', async () => {
            const filename = 'x/y/z/spam.py';
            const text = '<text>';
            raw.setup((r) => r.appendFile(filename, text)) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.appendText(filename, text);

            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.appendFile(TypeMoq.It.isAny(), TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.appendText('spam.py', '<text>');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('copyFile', () => {
        test('wraps the low-level function', async () => {
            const src = 'x/y/z/spam.py';
            const tgt = 'x/y/z/eggs.py';
            raw.setup((r) => r.dirname(tgt)) // Provide the target's parent.
                .returns(() => 'x/y/z');
            raw.setup((r) => r.stat(Uri('x/y/z'))) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            raw.setup((r) => r.copy(Uri(src), Uri(tgt), { overwrite: true })) // Expect the specific args.
                .returns(() => Promise.resolve());

            await filesystem.copyFile(src, tgt);

            verifyAll();
        });

        test('fails if target parent does not exist', async () => {
            raw.setup((r) => r.dirname(TypeMoq.It.isAny())) // Provide the target's parent.
                .returns(() => '');
            const err = vscode.FileSystemError.FileNotFound('...');
            raw.setup((r) => r.stat(TypeMoq.It.isAny())) // The parent dir exists.
                .returns(() => Promise.reject(err));

            const promise = filesystem.copyFile('spam', 'eggs');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.dirname(TypeMoq.It.isAny())) // Provide the target's parent.
                .returns(() => '');
            raw.setup((r) => r.stat(TypeMoq.It.isAny())) // The parent dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            raw.setup((r) => r.copy(TypeMoq.It.isAny(), TypeMoq.It.isAny(), { overwrite: true })) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.copyFile('spam', 'eggs');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('rmFile', () => {
        const opts = {
            recursive: false,
            useTrash: false
        };

        test('wraps the low-level function', async () => {
            const filename = 'x/y/z/spam.py';
            raw.setup((r) => r.delete(Uri(filename), opts)) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.rmfile(filename);

            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.delete(TypeMoq.It.isAny(), opts)) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.rmfile('spam.py');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('mkdirp', () => {
        test('wraps the low-level function', async () => {
            const dirname = 'x/y/z/spam';
            raw.setup((r) => r.createDirectory(Uri(dirname))) // expect the specific filename
                .returns(() => Promise.resolve());

            await filesystem.mkdirp(dirname);

            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.createDirectory(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.mkdirp('spam');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('rmdir', () => {
        const opts = {
            recursive: true,
            useTrash: false
        };

        test('directory is empty', async () => {
            const dirname = 'x/y/z/spam';
            raw.setup((r) => r.readDirectory(Uri(dirname))) // The dir is empty.
                .returns(() => Promise.resolve([]));
            raw.setup((r) => r.delete(Uri(dirname), opts)) // Expect the specific args.
                .returns(() => Promise.resolve());

            await filesystem.rmdir(dirname);

            verifyAll();
        });

        test('fails if readDirectory() fails (e.g. is a file)', async () => {
            raw.setup((r) => r.readDirectory(TypeMoq.It.isAny())) // It's not a directory.
                .throws(new Error('is a file'));

            const promise = filesystem.rmdir('spam');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });

        test('fails if not empty', async () => {
            const entries: [string, vscode.FileType][] = [
                ['dev1', vscode.FileType.Unknown],
                ['w', vscode.FileType.Directory],
                ['spam.py', vscode.FileType.File],
                ['other', vscode.FileType.SymbolicLink | vscode.FileType.File]
            ];
            raw.setup((r) => r.readDirectory(TypeMoq.It.isAny())) // The dir is not empty.
                .returns(() => Promise.resolve(entries));

            const promise = filesystem.rmdir('spam');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.readDirectory(TypeMoq.It.isAny())) // The "file" exists.
                .returns(() => Promise.resolve([]));
            raw.setup((r) => r.delete(TypeMoq.It.isAny(), opts)) // We don't care about the filename.
                .throws(new Error('oops!'));

            const promise = filesystem.rmdir('spam');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('rmtree', () => {
        const opts = {
            recursive: true,
            useTrash: false
        };

        test('wraps the low-level function', async () => {
            const dirname = 'x/y/z/spam';
            raw.setup((r) => r.stat(Uri(dirname))) // The dir exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            raw.setup((r) => r.delete(Uri(dirname), opts)) // Expect the specific dirname.
                .returns(() => Promise.resolve());

            await filesystem.rmtree(dirname);

            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.stat(TypeMoq.It.isAny())) // The "file" exists.
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            raw.setup((r) => r.delete(TypeMoq.It.isAny(), opts)) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.rmtree('spam');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('listdir', () => {
        test('mixed', async () => {
            const dirname = 'x/y/z/spam';
            const actual: [string, vscode.FileType][] = [
                ['dev1', vscode.FileType.Unknown],
                ['w', vscode.FileType.Directory],
                ['spam.py', vscode.FileType.File],
                ['other', vscode.FileType.SymbolicLink | vscode.FileType.File]
            ];
            const expected = actual.map(([basename, filetype]) => {
                const filename = `x/y/z/spam/${basename}`;
                raw.setup((r) => r.join(dirname, basename)) // Expect the specific basename.
                    .returns(() => filename);
                return [filename, filetype] as [string, vscode.FileType];
            });
            raw.setup((r) => r.readDirectory(Uri(dirname))) // Expect the specific filename.
                .returns(() => Promise.resolve(actual));

            const entries = await filesystem.listdir(dirname);

            expect(entries).to.deep.equal(expected);
            verifyAll();
        });

        test('empty', async () => {
            const dirname = 'x/y/z/spam';
            const expected: [string, vscode.FileType][] = [];
            raw.setup((r) => r.readDirectory(Uri(dirname))) // expect the specific filename
                .returns(() => Promise.resolve([]));

            const entries = await filesystem.listdir(dirname);

            expect(entries).to.deep.equal(expected);
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.readDirectory(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            const promise = filesystem.listdir('spam');

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('statSync', () => {
        test('wraps the low-level function (filetype: unknown)', async () => {
            const filename = 'x/y/z/spam.py';
            const expected: vscode.FileStat = {
                type: vscode.FileType.Unknown,
                size: 10,
                ctime: 101,
                mtime: 102
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any;
            const lstat = createMockLegacyStat();
            setupStatFileType(lstat, vscode.FileType.Unknown);
            copyStat(expected, lstat);
            raw.setup((r) => r.lstatSync(filename)) // expect the specific filename
                .returns(() => lstat.object);

            const stat = filesystem.statSync(filename);

            expect(stat).to.deep.equal(expected);
            verifyAll();
        });

        [
            { kind: 'file', filetype: vscode.FileType.File },
            { kind: 'dir', filetype: vscode.FileType.Directory }
        ].forEach((testData) => {
            test(`wraps the low-level function (filetype: ${testData.kind})`, async () => {
                const filename = 'x/y/z/spam.py';
                const expected: vscode.FileStat = {
                    type: testData.filetype,
                    size: 10,
                    ctime: 101,
                    mtime: 102
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any;
                const lstat = createMockLegacyStat();
                lstat
                    .setup((s) => s.isSymbolicLink()) // not a symlink
                    .returns(() => false);
                setupStatFileType(lstat, testData.filetype);
                copyStat(expected, lstat);
                raw.setup((r) => r.lstatSync(filename)) // expect the specific filename
                    .returns(() => lstat.object);

                const stat = filesystem.statSync(filename);

                expect(stat).to.deep.equal(expected);
                verifyAll();
            });
        });

        [
            { kind: 'file', filetype: vscode.FileType.File },
            { kind: 'dir', filetype: vscode.FileType.Directory },
            { kind: 'unknown', filetype: vscode.FileType.Unknown }
        ].forEach((testData) => {
            test(`wraps the low-level function (filetype: ${testData.kind} symlink)`, async () => {
                const filename = 'x/y/z/spam.py';
                const expected: vscode.FileStat = {
                    type: testData.filetype | vscode.FileType.SymbolicLink,
                    size: 10,
                    ctime: 101,
                    mtime: 102
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any;
                const lstat = createMockLegacyStat();
                lstat
                    .setup((s) => s.isSymbolicLink()) // not a symlink
                    .returns(() => true);
                raw.setup((r) => r.lstatSync(filename)) // expect the specific filename
                    .returns(() => lstat.object);
                const old = createMockLegacyStat();
                setupStatFileType(old, testData.filetype);
                copyStat(expected, old);
                raw.setup((r) => r.statSync(filename)) // expect the specific filename
                    .returns(() => old.object);

                const stat = filesystem.statSync(filename);

                expect(stat).to.deep.equal(expected);
                verifyAll();
            });
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.lstatSync(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            expect(() => {
                filesystem.statSync('spam.py');
            }).to.throw();
            verifyAll();
        });
    });

    suite('readTextSync', () => {
        test('wraps the low-level function', () => {
            const filename = 'x/y/z/spam.py';
            const expected = '<text>';
            raw.setup((r) => r.readFileSync(filename, 'utf8')) // expect the specific filename
                .returns(() => expected);

            const text = filesystem.readTextSync(filename);

            expect(text).to.equal(expected);
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.readFileSync(TypeMoq.It.isAny(), TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            expect(() => filesystem.readTextSync('spam.py')).to.throw();

            verifyAll();
        });
    });

    suite('createReadStream', () => {
        test('wraps the low-level function', () => {
            const filename = 'x/y/z/spam.py';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const expected = {} as any;
            raw.setup((r) => r.createReadStream(filename)) // expect the specific filename
                .returns(() => expected);

            const stream = filesystem.createReadStream(filename);

            expect(stream).to.equal(expected);
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.createReadStream(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            expect(() => filesystem.createReadStream('spam.py')).to.throw();

            verifyAll();
        });
    });

    suite('createWriteStream', () => {
        test('wraps the low-level function', () => {
            const filename = 'x/y/z/spam.py';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const expected = {} as any;
            raw.setup((r) => r.createWriteStream(filename)) // expect the specific filename
                .returns(() => expected);

            const stream = filesystem.createWriteStream(filename);

            expect(stream).to.equal(expected);
            verifyAll();
        });

        test('fails if the low-level call fails', async () => {
            raw.setup((r) => r.createWriteStream(TypeMoq.It.isAny())) // We don't care about the filename.
                .throws(new Error('file not found'));

            expect(() => filesystem.createWriteStream('spam.py')).to.throw();

            verifyAll();
        });
    });
});

interface IUtilsDeps extends IRawFileSystem, IFileSystemPaths, IFileSystemPathUtils, ITempFileSystem {
    // helpers
    getHash(data: string): string;
    globFile(pat: string, options?: { cwd: string }): Promise<string[]>;
}

suite('FileSystemUtils', () => {
    let deps: TypeMoq.IMock<IUtilsDeps>;
    let stats: TypeMoq.IMock<vscode.FileStat>[];
    let utils: FileSystemUtils;
    setup(() => {
        deps = TypeMoq.Mock.ofType<IUtilsDeps>(undefined, TypeMoq.MockBehavior.Strict);

        stats = [];
        utils = new FileSystemUtils(
            // Since it's a mock we can just use it for all 3 values.
            deps.object, // rawFS
            deps.object, // pathUtils
            deps.object, // paths
            deps.object, // tempFS
            (data: string) => deps.object.getHash(data),
            (pat: string, options?: { cwd: string }) => deps.object.globFile(pat, options)
        );
    });
    function verifyAll() {
        deps.verifyAll();
        stats.forEach((stat) => {
            stat.verifyAll();
        });
    }
    function createMockStat(): TypeMoq.IMock<vscode.FileStat> {
        const stat = TypeMoq.Mock.ofType<vscode.FileStat>(undefined, TypeMoq.MockBehavior.Strict);
        // This is necessary because passing "mock.object" to
        // Promise.resolve() triggers the lookup.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stat.setup((s: any) => s.then)
            .returns(() => undefined)
            .verifiable(TypeMoq.Times.atLeast(0));
        stats.push(stat);
        return stat;
    }

    suite('createDirectory', () => {
        test('wraps the low-level function', async () => {
            const dirname = 'x/y/z/spam';
            deps.setup((d) => d.mkdirp(dirname)) // expect the specific filename
                .returns(() => Promise.resolve());

            await utils.createDirectory(dirname);

            verifyAll();
        });
    });

    suite('deleteDirectory', () => {
        test('wraps the low-level function', async () => {
            const dirname = 'x/y/z/spam';
            deps.setup((d) => d.rmdir(dirname)) // expect the specific filename
                .returns(() => Promise.resolve());

            await utils.deleteDirectory(dirname);

            verifyAll();
        });
    });

    suite('deleteFile', () => {
        test('wraps the low-level function', async () => {
            const filename = 'x/y/z/spam.py';
            deps.setup((d) => d.rmfile(filename)) // expect the specific filename
                .returns(() => Promise.resolve());

            await utils.deleteFile(filename);

            verifyAll();
        });
    });

    suite('pathExists', () => {
        test('exists (without type)', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(filename);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('does not exist', async () => {
            const filename = 'x/y/z/spam.py';
            const err = vscode.FileSystemError.FileNotFound(filename);
            deps.setup((d) => d.stat(filename)) // The file does not exist.
                .throws(err);

            const exists = await utils.pathExists(filename);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('ignores errors from stat()', async () => {
            const filename = 'x/y/z/spam.py';
            deps.setup((d) => d.stat(filename)) // It's broken.
                .returns(() => Promise.reject(new Error('oops!')));

            const exists = await utils.pathExists(filename);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('matches (type: undefined)', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(filename);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('matches (type: file)', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a file.
                .returns(() => vscode.FileType.File);
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(filename, vscode.FileType.File);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('mismatch (type: file)', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a directory.
                .returns(() => vscode.FileType.Directory);
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(filename, vscode.FileType.File);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('matches (type: directory)', async () => {
            const dirname = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a directory.
                .returns(() => vscode.FileType.Directory);
            deps.setup((d) => d.stat(dirname)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(dirname, vscode.FileType.Directory);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('mismatch (type: directory)', async () => {
            const dirname = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a file.
                .returns(() => vscode.FileType.File);
            deps.setup((d) => d.stat(dirname)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(dirname, vscode.FileType.Directory);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('symlinks are followed', async () => {
            const symlink = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a symlink to a file.
                .returns(() => vscode.FileType.File | vscode.FileType.SymbolicLink)
                .verifiable(TypeMoq.Times.exactly(3));
            deps.setup((d) => d.stat(symlink)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object))
                .verifiable(TypeMoq.Times.exactly(3));

            const exists = await utils.pathExists(symlink, vscode.FileType.SymbolicLink);
            const destIsFile = await utils.pathExists(symlink, vscode.FileType.File);
            const destIsDir = await utils.pathExists(symlink, vscode.FileType.Directory);

            expect(exists).to.equal(true);
            expect(destIsFile).to.equal(true);
            expect(destIsDir).to.equal(false);
            verifyAll();
        });

        test('mismatch (type: symlink)', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a file.
                .returns(() => vscode.FileType.File);
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(filename, vscode.FileType.SymbolicLink);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('matches (type: unknown)', async () => {
            const sockFile = 'x/y/z/ipc.sock';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a socket.
                .returns(() => vscode.FileType.Unknown);
            deps.setup((d) => d.stat(sockFile)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(sockFile, vscode.FileType.Unknown);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('mismatch (type: unknown)', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a file.
                .returns(() => vscode.FileType.File);
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.pathExists(filename, vscode.FileType.Unknown);

            expect(exists).to.equal(false);
            verifyAll();
        });
    });

    suite('fileExists', () => {
        test('want file, got file', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a File.
                .returns(() => vscode.FileType.File);
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.fileExists(filename);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('want file, not file', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a directory.
                .returns(() => vscode.FileType.Directory);
            deps.setup((d) => d.stat(filename)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.fileExists(filename);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('symlink', async () => {
            const symlink = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a symlink to a File.
                .returns(() => vscode.FileType.File | vscode.FileType.SymbolicLink);
            deps.setup((d) => d.stat(symlink)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.fileExists(symlink);

            // This is because we currently use stat() and not lstat().
            expect(exists).to.equal(true);
            verifyAll();
        });

        test('unknown', async () => {
            const sockFile = 'x/y/z/ipc.sock';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a socket.
                .returns(() => vscode.FileType.Unknown);
            deps.setup((d) => d.stat(sockFile)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.fileExists(sockFile);

            expect(exists).to.equal(false);
            verifyAll();
        });
    });

    suite('directoryExists', () => {
        test('want directory, got directory', async () => {
            const dirname = 'x/y/z/spam';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a directory.
                .returns(() => vscode.FileType.Directory);
            deps.setup((d) => d.stat(dirname)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.directoryExists(dirname);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('want directory, not directory', async () => {
            const dirname = 'x/y/z/spam';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a file.
                .returns(() => vscode.FileType.File);
            deps.setup((d) => d.stat(dirname)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.directoryExists(dirname);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('symlink', async () => {
            const symlink = 'x/y/z/spam';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a symlink to a directory.
                .returns(() => vscode.FileType.Directory | vscode.FileType.SymbolicLink);
            deps.setup((d) => d.stat(symlink)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.directoryExists(symlink);

            // This is because we currently use stat() and not lstat().
            expect(exists).to.equal(true);
            verifyAll();
        });

        test('unknown', async () => {
            const sockFile = 'x/y/z/ipc.sock';
            const stat = createMockStat();
            stat.setup((s) => s.type) // It's a socket.
                .returns(() => vscode.FileType.Unknown);
            deps.setup((d) => d.stat(sockFile)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const exists = await utils.directoryExists(sockFile);

            expect(exists).to.equal(false);
            verifyAll();
        });
    });

    suite('listdir', () => {
        test('wraps the raw call on success', async () => {
            const dirname = 'x/y/z/spam';
            const expected: [string, vscode.FileType][] = [
                ['x/y/z/spam/dev1', vscode.FileType.Unknown],
                ['x/y/z/spam/w', vscode.FileType.Directory],
                ['x/y/z/spam/spam.py', vscode.FileType.File],
                ['x/y/z/spam/other', vscode.FileType.SymbolicLink | vscode.FileType.File]
            ];
            deps.setup((d) => d.listdir(dirname)) // Full results get returned from RawFileSystem.listdir().
                .returns(() => Promise.resolve(expected));

            const entries = await utils.listdir(dirname);

            expect(entries).to.deep.equal(expected);
            verifyAll();
        });

        test('returns [] if the directory does not exist', async () => {
            const dirname = 'x/y/z/spam';
            const err = vscode.FileSystemError.FileNotFound(dirname);
            deps.setup((d) => d.listdir(dirname)) // The "file" does not exist.
                .returns(() => Promise.reject(err));
            deps.setup((d) => d.stat(dirname)) // The "file" does not exist.
                .returns(() => Promise.reject(err));

            const entries = await utils.listdir(dirname);

            expect(entries).to.deep.equal([]);
            verifyAll();
        });

        test('fails if not a directory', async () => {
            const dirname = 'x/y/z/spam';
            const err = vscode.FileSystemError.FileNotADirectory(dirname);
            deps.setup((d) => d.listdir(dirname)) // Fail (async) with not-a-directory.
                .returns(() => Promise.reject(err));
            const stat = createMockStat();
            deps.setup((d) => d.stat(dirname)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const promise = utils.listdir(dirname);

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });

        test('fails if the raw call promise fails', async () => {
            const dirname = 'x/y/z/spam';
            const err = new Error('oops!');
            deps.setup((d) => d.listdir(dirname)) // Fail (async) with an arbitrary error.
                .returns(() => Promise.reject(err));
            deps.setup((d) => d.stat(dirname)) // Fail with file-not-found.
                .throws(vscode.FileSystemError.FileNotFound(dirname));

            const entries = await utils.listdir(dirname);

            expect(entries).to.deep.equal([]);
            verifyAll();
        });

        test('fails if the raw call fails', async () => {
            const dirname = 'x/y/z/spam';
            const err = new Error('oops!');
            deps.setup((d) => d.listdir(dirname)) // Fail with an arbirary error.
                .throws(err);
            const stat = createMockStat();
            deps.setup((d) => d.stat(dirname)) // The "file" exists.
                .returns(() => Promise.resolve(stat.object));

            const promise = utils.listdir(dirname);

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('getSubDirectories', () => {
        test('filters out non-subdirs', async () => {
            const dirname = 'x/y/z/spam';
            const entries: [string, vscode.FileType][] = [
                ['x/y/z/spam/dev1', vscode.FileType.Unknown],
                ['x/y/z/spam/w', vscode.FileType.Directory],
                ['x/y/z/spam/spam.py', vscode.FileType.File],
                ['x/y/z/spam/v', vscode.FileType.Directory],
                ['x/y/z/spam/eggs.py', vscode.FileType.File],
                ['x/y/z/spam/other1', vscode.FileType.SymbolicLink | vscode.FileType.File],
                ['x/y/z/spam/other2', vscode.FileType.SymbolicLink | vscode.FileType.Directory]
            ];
            const expected = [
                // only entries with FileType.Directory
                'x/y/z/spam/w',
                'x/y/z/spam/v',
                'x/y/z/spam/other2'
            ];
            deps.setup((d) => d.listdir(dirname)) // Full results get returned from RawFileSystem.listdir().
                .returns(() => Promise.resolve(entries));

            const filtered = await utils.getSubDirectories(dirname);

            expect(filtered).to.deep.equal(expected);
            verifyAll();
        });
    });

    suite('getFiles', () => {
        test('filters out non-files', async () => {
            const filename = 'x/y/z/spam';
            const entries: [string, vscode.FileType][] = [
                ['x/y/z/spam/dev1', vscode.FileType.Unknown],
                ['x/y/z/spam/w', vscode.FileType.Directory],
                ['x/y/z/spam/spam.py', vscode.FileType.File],
                ['x/y/z/spam/v', vscode.FileType.Directory],
                ['x/y/z/spam/eggs.py', vscode.FileType.File],
                ['x/y/z/spam/other1', vscode.FileType.SymbolicLink | vscode.FileType.File],
                ['x/y/z/spam/other2', vscode.FileType.SymbolicLink | vscode.FileType.Directory]
            ];
            const expected = [
                // only entries with FileType.File
                'x/y/z/spam/spam.py',
                'x/y/z/spam/eggs.py',
                'x/y/z/spam/other1'
            ];
            deps.setup((d) => d.listdir(filename)) // Full results get returned from RawFileSystem.listdir().
                .returns(() => Promise.resolve(entries));

            const filtered = await utils.getFiles(filename);

            expect(filtered).to.deep.equal(expected);
            verifyAll();
        });
    });

    suite('isDirReadonly', () => {
        setup(() => {
            deps.setup((d) => d.sep) // The value really doesn't matter.
                .returns(() => '/');
        });

        test('is not readonly', async () => {
            const dirname = 'x/y/z/spam';
            const filename = `${dirname}/___vscpTest___`;
            deps.setup((d) => d.stat(dirname)) // Success!
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            deps.setup((d) => d.writeText(filename, '')) // Success!
                .returns(() => Promise.resolve());
            deps.setup((d) => d.rmfile(filename)) // Success!
                .returns(() => Promise.resolve());

            const isReadonly = await utils.isDirReadonly(dirname);

            expect(isReadonly).to.equal(false);
            verifyAll();
        });

        test('is readonly', async () => {
            const dirname = 'x/y/z/spam';
            const filename = `${dirname}/___vscpTest___`;
            const err = new Error('not permitted');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (err as any).code = 'EACCES'; // errno
            deps.setup((d) => d.stat(dirname)) // Success!
                .returns(() => Promise.resolve(undefined as unknown as vscode.FileStat));
            deps.setup((d) => d.writeText(filename, '')) // not permitted
                .returns(() => Promise.reject(err));

            const isReadonly = await utils.isDirReadonly(dirname);

            expect(isReadonly).to.equal(true);
            verifyAll();
        });

        test('fails if the directory does not exist', async () => {
            const dirname = 'x/y/z/spam';
            const err = new Error('not found');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (err as any).code = 'ENOENT'; // errno
            deps.setup((d) => d.stat(dirname)) // file-not-found
                .returns(() => Promise.reject(err));

            const promise = utils.isDirReadonly(dirname);

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('getFileHash', () => {
        test('Getting hash for a file should return non-empty string', async () => {
            const filename = 'x/y/z/spam.py';
            const stat = createMockStat();
            stat.setup((s) => s.ctime) // created
                .returns(() => 100);
            stat.setup((s) => s.mtime) // modified
                .returns(() => 120);
            deps.setup((d) => d.lstat(filename)) // file exists
                .returns(() => Promise.resolve(stat.object));
            deps.setup((d) => d.getHash('100-120')) // built from ctime and mtime
                .returns(() => 'deadbeef');

            const hash = await utils.getFileHash(filename);

            expect(hash).to.equal('deadbeef');
            verifyAll();
        });

        test('Getting hash for non existent file should throw error', async () => {
            const filename = 'x/y/z/spam.py';
            const err = vscode.FileSystemError.FileNotFound(filename);
            deps.setup((d) => d.lstat(filename)) // file-not-found
                .returns(() => Promise.reject(err));

            const promise = utils.getFileHash(filename);

            await expect(promise).to.eventually.be.rejected;
            verifyAll();
        });
    });

    suite('search', () => {
        test('found matches (without cwd)', async () => {
            const pattern = `x/y/z/spam.*`;
            const expected: string[] = [
                // We can pretend that there were other files
                // that were ignored.
                'x/y/z/spam.py',
                'x/y/z/spam.pyc',
                'x/y/z/spam.so',
                'x/y/z/spam.data'
            ];
            deps.setup((d) => d.globFile(pattern, undefined)) // found some
                .returns(() => Promise.resolve(expected));

            const files = await utils.search(pattern);

            expect(files).to.deep.equal(expected);
            verifyAll();
        });

        test('found matches (with cwd)', async () => {
            const pattern = `x/y/z/spam.*`;
            const cwd = 'a/b/c';
            const expected: string[] = [
                // We can pretend that there were other files
                // that were ignored.
                'x/y/z/spam.py',
                'x/y/z/spam.pyc',
                'x/y/z/spam.so',
                'x/y/z/spam.data'
            ];
            deps.setup((d) => d.globFile(pattern, { cwd: cwd })) // found some
                .returns(() => Promise.resolve(expected));

            const files = await utils.search(pattern, cwd);

            expect(files).to.deep.equal(expected);
            verifyAll();
        });

        test('no matches (empty)', async () => {
            const pattern = `x/y/z/spam.*`;
            deps.setup((d) => d.globFile(pattern, undefined)) // found none
                .returns(() => Promise.resolve([]));

            const files = await utils.search(pattern);

            expect(files).to.deep.equal([]);
            verifyAll();
        });

        test('no matches (undefined)', async () => {
            const pattern = `x/y/z/spam.*`;
            deps.setup((d) => d.globFile(pattern, undefined)) // found none
                .returns(() => Promise.resolve(undefined as unknown as string[]));

            const files = await utils.search(pattern);

            expect(files).to.deep.equal([]);
            verifyAll();
        });
    });

    suite('fileExistsSync', () => {
        test('file exists', async () => {
            const filename = 'x/y/z/spam.py';
            deps.setup((d) => d.statSync(filename)) // The file exists.
                .returns(() => undefined as unknown as vscode.FileStat);

            const exists = utils.fileExistsSync(filename);

            expect(exists).to.equal(true);
            verifyAll();
        });

        test('file does not exist', async () => {
            const filename = 'x/y/z/spam.py';
            const err = vscode.FileSystemError.FileNotFound('...');
            deps.setup((d) => d.statSync(filename)) // The file does not exist.
                .throws(err);

            const exists = utils.fileExistsSync(filename);

            expect(exists).to.equal(false);
            verifyAll();
        });

        test('fails if low-level call fails', async () => {
            const filename = 'x/y/z/spam.py';
            const err = new Error('oops!');
            deps.setup((d) => d.statSync(filename)) // big badda boom
                .throws(err);

            expect(() => utils.fileExistsSync(filename)).to.throw(err);
            verifyAll();
        });
    });
});
