import type { SDKInitOptions } from '../types/config.js';
import { type InitResponse } from './remote-config-client.js';
export interface RecoveryWorkerOptions {
    readonly baseDelayMs?: number | undefined;
    readonly maxDelayMs?: number | undefined;
    readonly activateFn?: ((response: InitResponse) => Promise<void>) | undefined;
}
export declare function getDefaultBaseDelayMs(): number;
export declare class BackgroundRecoveryWorker {
    private static activeInstance;
    private readonly options;
    private readonly baseDelayMs;
    private readonly maxDelayMs;
    private readonly activateFn?;
    private readonly abortController;
    private attempt;
    private timer;
    private running;
    private stopped;
    constructor(options: SDKInitOptions, workerOptions?: RecoveryWorkerOptions);
    static getInstance(): BackgroundRecoveryWorker | null;
    static start(options: SDKInitOptions, workerOptions?: RecoveryWorkerOptions): BackgroundRecoveryWorker;
    static stop(): void;
    isStopped(): boolean;
    isRunning(): boolean;
    getAttemptCount(): number;
    start(): void;
    stop(): void;
    private scheduleNextAttempt;
    private executeAttempt;
}
