// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { cloneDeep } from 'lodash';
import { Memento, Uri } from 'vscode';
import { traceInfo } from '../../../platform/logging';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths.node';
import { IMemento, GLOBAL_MEMENTO, ICryptoUtils } from '../../../platform/common/types';
import { sendTelemetryEvent } from '../../../telemetry';
import { Telemetry } from '../../../webviews/webview-side/common/constants';

export const ActiveKernelIdList = 'Active_Kernel_Id_List';
// This is the number of kernel ids that will be remembered between opening and closing VS code
export const MaximumKernelIdListSize = 100;

type KernelIdListEntry = {
    fileHash: string;
    kernelId: string | undefined;
};

@injectable()
export class PreferredRemoteKernelIdProvider {
    constructor(
        @inject(IMemento) @named(GLOBAL_MEMENTO) private readonly globalMemento: Memento,
        @inject(ICryptoUtils) private crypto: ICryptoUtils
    ) {}

    public getPreferredRemoteKernelId(uri: Uri): string | undefined {
        // Stored as a list so we don't take up too much space
        const list: KernelIdListEntry[] = this.globalMemento.get<KernelIdListEntry[]>(ActiveKernelIdList, []);
        if (list) {
            // Not using a map as we're only going to store the last 40 items.
            const fileHash = this.crypto.createHash(uri.toString(), 'string');
            const entry = list.find((l) => l.fileHash === fileHash);
            traceInfo(`Preferred Remote kernel for ${getDisplayPath(uri)} is ${entry?.kernelId}`);
            return entry?.kernelId;
        }
    }

    public async storePreferredRemoteKernelId(uri: Uri, id: string | undefined): Promise<void> {
        // Don't update in memory representation.
        const list: KernelIdListEntry[] = cloneDeep(
            this.globalMemento.get<KernelIdListEntry[]>(ActiveKernelIdList, [])
        );
        const fileHash = this.crypto.createHash(uri.toString(), 'string');
        const index = list.findIndex((l) => l.fileHash === fileHash);
        // Always remove old spot (we'll push on the back for new ones)
        if (index >= 0) {
            list.splice(index, 1);
        }

        // If adding a new one, push
        if (id) {
            list.push({ fileHash, kernelId: id });
        }

        // Prune list if too big
        sendTelemetryEvent(Telemetry.NumberOfSavedRemoteKernelIds, undefined, { count: list.length });
        while (list.length > MaximumKernelIdListSize) {
            list.shift();
        }
        traceInfo(`Storing Preferred remote kernel for ${getDisplayPath(uri)} is ${id}`);
        await this.globalMemento.update(ActiveKernelIdList, list);
    }
}
