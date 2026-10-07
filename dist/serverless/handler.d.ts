export interface ServerlessHandlerOptions {
    /**
     * Maximum time in milliseconds to wait for telemetry to flush on handler completion or error.
     * Default: 1500ms.
     */
    readonly flushTimeoutMs?: number;
    /**
     * Whether to capture unhandled exceptions thrown by the handler.
     * Default: true.
     */
    readonly captureErrors?: boolean;
    /**
     * Whether to automatically set `context.callbackWaitsForEmptyEventLoop = false`
     * on AWS Lambda context objects.
     * Default: true.
     */
    readonly callbackWaitsForEmptyEventLoop?: boolean;
}
export type ServerlessHandler<TEvent = unknown, TContext = unknown, TResult = unknown> = (event: TEvent, context: TContext, callback?: unknown) => Promise<TResult> | TResult;
/**
 * Wrap an AWS Lambda or serverless function handler to guarantee telemetry delivery.
 *
 * In serverless environments, background timers cannot flush events after the handler returns
 * because the hypervisor immediately freezes CPU execution.
 *
 * `wrapHandler`:
 * 1. Sets `context.callbackWaitsForEmptyEventLoop = false` (AWS Lambda best practice).
 * 2. Catches unhandled errors, captures them with `captureException`, flushes within deadline, and rethrows.
 * 3. On successful return, flushes pending traces, metrics, and logs synchronously before execution freeze.
 */
export declare function wrapHandler<TEvent = unknown, TContext = unknown, TResult = unknown>(handler: ServerlessHandler<TEvent, TContext, TResult>, options?: ServerlessHandlerOptions): (event: TEvent, context: TContext, callback?: unknown) => Promise<TResult>;
