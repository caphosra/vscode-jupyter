// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable, Event, NotebookCell, NotebookDocument, NotebookEditor, Uri } from 'vscode';
import { IKernel, KernelConnectionMetadata } from '../kernels/types';
import { Resource, InteractiveWindowMode, ICell } from '../platform/common/types';

export type INativeInteractiveWindow = { notebookUri: Uri; inputUri: Uri; notebookEditor: NotebookEditor };

export const IInteractiveWindowDebugger = Symbol('IInteractiveWindowDebugger');
export interface IInteractiveWindowDebugger {
    attach(kernel: IKernel): Promise<void>;
    detach(kernel: IKernel): Promise<void>;
    enable(kernel: IKernel): void;
    disable(kernel: IKernel): void;
}

export const IInteractiveWindowProvider = Symbol('IInteractiveWindowProvider');
export interface IInteractiveWindowProvider {
    /**
     * The active interactive window if it has the focus.
     */
    readonly activeWindow: IInteractiveWindow | undefined;
    /**
     * List of open interactive windows
     */
    readonly windows: ReadonlyArray<IInteractiveWindow>;
    /**
     * Event fired when the active interactive window changes
     */
    readonly onDidChangeActiveInteractiveWindow: Event<IInteractiveWindow | undefined>;
    /**
     * Event fired when an interactive window is created
     */
    readonly onDidCreateInteractiveWindow: Event<IInteractiveWindow>;
    /**
     * Gets or creates a new interactive window and associates it with the owner. If no owner, marks as a non associated.
     * @param {Resource} owner File that started this interactive window
     * @param {KernelConnectionMetadata} [connection] The kernel connection to be used when starting/connecting to the kernel.
     */
    getOrCreate(owner: Resource, connection?: KernelConnectionMetadata): Promise<IInteractiveWindow>;
    /**
     * Given a text document, return the associated interactive window if one exists.
     * @param owner The URI of a text document which may be associated with an interactive window.
     */
    get(owner: Uri): IInteractiveWindow | undefined;
}

export interface IInteractiveBase extends Disposable {
    hasCell(id: string): Promise<boolean>;
}

export interface IInteractiveWindow extends IInteractiveBase {
    readonly onDidChangeViewState: Event<void>;
    readonly notebookEditor: NotebookEditor | undefined;
    readonly owner: Resource;
    readonly submitters: Uri[];
    readonly notebookUri?: Uri;
    readonly inputUri?: Uri;
    readonly notebookDocument?: NotebookDocument;
    closed: Event<void>;
    addCode(code: string, file: Uri, line: number): Promise<boolean>;
    addErrorMessage(message: string, cell: NotebookCell): Promise<void>;
    debugCode(code: string, file: Uri, line: number): Promise<boolean>;
    expandAllCells(): Promise<void>;
    collapseAllCells(): Promise<void>;
    scrollToCell(id: string): void;
    exportAs(cells?: ICell[]): void;
    export(cells?: ICell[]): void;
}

export interface IInteractiveWindowLoadable extends IInteractiveWindow {
    changeMode(newMode: InteractiveWindowMode): void;
}
