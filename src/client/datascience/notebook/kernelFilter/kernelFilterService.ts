// import { INotebookControllerManager } from './types';

import { inject, injectable } from 'inversify';
import { EventEmitter, NotebookDocument } from 'vscode';
import { KernelConnectionMetadata } from '../../jupyter/kernels/types';
import { KernelFilterStorage } from './kernelFilterStorage';

@injectable()
export class KernelFilterService {
    private readonly _onChanged = new EventEmitter<void>();
    public get onDidChange(){
        return this._onChanged.event;
    }
    constructor(@inject(KernelFilterStorage) private readonly storage: KernelFilterStorage
        ) {}

    public isKernelHidden(kernelConnection: KernelConnectionMetadata): boolean {
        const hiddenList = this.storage.getHiddenKernels();
        return hiddenList.some(item => item.id === kernelConnection.id);
    }
    public shouldCorrespondingControllerBeDisplay(
        _document: NotebookDocument,
        _kernelConnection: KernelConnectionMetadata
    ): boolean {
        return true;
    }
}
