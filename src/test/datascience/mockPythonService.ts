// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import {
    ExecutionResult,
    IPythonExecutionService,
    ObservableExecutionResult,
    SpawnOptions
} from '../../platform/common/process/types.node';
import { buildPythonExecInfo } from '../../platform/pythonEnvironments/exec';
import { InterpreterInformation, PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { MockProcessService } from './mockProcessService';

export class MockPythonService implements IPythonExecutionService {
    private interpreter: PythonEnvironment;
    private procService: MockProcessService = new MockProcessService();

    constructor(interpreter: PythonEnvironment) {
        this.interpreter = interpreter;
    }

    public getInterpreterInformation(): Promise<InterpreterInformation> {
        return Promise.resolve(this.interpreter);
    }

    public getExecutablePath(): Promise<string> {
        return Promise.resolve(this.interpreter.path);
    }

    public isModuleInstalled(_moduleName: string): Promise<boolean> {
        return Promise.resolve(false);
    }

    public execObservable(args: string[], options: SpawnOptions): ObservableExecutionResult<string> {
        return this.procService.execObservable(this.interpreter.path, args, options);
    }
    public execModuleObservable(
        moduleName: string,
        args: string[],
        options: SpawnOptions
    ): ObservableExecutionResult<string> {
        return this.procService.execObservable(this.interpreter.path, ['-m', moduleName, ...args], options);
    }
    public exec(args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        return this.procService.exec(this.interpreter.path, args, options);
    }

    public execModule(moduleName: string, args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        return this.procService.exec(this.interpreter.path, ['-m', moduleName, ...args], options);
    }

    public addExecResult(args: (string | RegExp)[], result: () => Promise<ExecutionResult<string>>) {
        this.procService.addExecResult(this.interpreter.path, args, result);
    }

    public addExecModuleResult(
        moduleName: string,
        args: (string | RegExp)[],
        result: () => Promise<ExecutionResult<string>>
    ) {
        this.procService.addExecResult(this.interpreter.path, ['-m', moduleName, ...args], result);
    }

    public addExecObservableResult(args: (string | RegExp)[], result: () => ObservableExecutionResult<string>) {
        this.procService.addExecObservableResult(this.interpreter.path, args, result);
    }

    public addExecModuleObservableResult(
        moduleName: string,
        args: (string | RegExp)[],
        result: () => ObservableExecutionResult<string>
    ) {
        this.procService.addExecObservableResult(this.interpreter.path, ['-m', moduleName, ...args], result);
    }

    public setDelay(timeout: number | undefined) {
        this.procService.setDelay(timeout);
    }

    public getExecutionInfo(args: string[]) {
        return buildPythonExecInfo(this.interpreter.path, args);
    }
}
