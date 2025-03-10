// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

/* eslint-disable @typescript-eslint/no-explicit-any, , no-invalid-this, max-classes-per-file */

import { expect } from 'chai';
import { ChildProcess, spawn } from 'child_process';
import { ProcessService } from '../../../platform/common/process/proc.node';
import { createDeferred, Deferred } from '../../../platform/common/utils/async';
import { PYTHON_PATH } from '../../common';

interface IProcData {
    proc: ChildProcess;
    exited: Deferred<Boolean>;
}

suite('Process - Process Service', function () {
    // eslint-disable-next-line no-invalid-this
    this.timeout(5000);
    const procsToKill: IProcData[] = [];
    teardown(() => {
        procsToKill.forEach((p) => {
            if (!p.exited.resolved) {
                p.proc.kill();
            }
        });
    });

    function spawnProc(): IProcData {
        const proc = spawn(PYTHON_PATH, ['-c', 'while(True): import time;time.sleep(0.5);print(1)']);
        const exited = createDeferred<Boolean>();
        proc.on('exit', () => exited.resolve(true));
        procsToKill.push({ proc, exited });

        return procsToKill[procsToKill.length - 1];
    }

    test('Process is killed', async () => {
        const proc = spawnProc();

        ProcessService.kill(proc.proc.pid);

        expect(await proc.exited.promise).to.equal(true, 'process did not die');
    });
    test('Process is alive', async () => {
        const proc = spawnProc();

        expect(ProcessService.isAlive(proc.proc.pid)).to.equal(true, 'process is not alive');
    });
});
