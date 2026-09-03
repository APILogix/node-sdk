/**
 * SDK Lifecycle — enterprise-grade graceful shutdown and reinit.
 *
 * Design principles:
 * - Bounded shutdown with deterministic timeout via Promise.race.
 * - Single-flight shutdown: concurrent calls share the same promise.
 * - Reverse-order teardown (LIFO): subsystems started last are torn down first.
 * - Idempotent reinit: every singleton, timer, and process listener is fully
 *   reset before the next init() can begin.
 * - No event leakage: shutdown rejects new events; pending pipelines drain
 *   to completion before disposal.
 * - No silent failures: per-step errors are captured, logged, and aggregated
 *   into the shutdown result for observability.
 *
 * Reinit guarantees (the contract for warm-start / hot-reload / serverless):
 *   1. ConfigManager singleton is destroyed; refresh + retry timers cleared.
 *   2. Process signal handlers (SIGTERM/SIGINT) are fully removed.
 *   3. Auto-instrumentation guard symbol is cleared.
 *   4. Global error handlers (uncaughtException/unhandledRejection) detached.
 *   5. Console.error wrapper unwrapped, Error.stackTraceLimit restored.
 *   6. All subsystem singletons (Logging, Profiling, Cron, Session,
 *      FeatureController, KillswitchEngine, SamplingEngine, LimitsEngine,
 *      SecurityScrubber, TransportRouter, Tracer) are reset.
 *   7. Memory pressure monitor stopped, circuit breaker / rate limiter reset.
 *   8. Persistent storage write chain drained, file handle released.
 */
export interface ShutdownStepError {
    readonly step: string;
    readonly error: unknown;
}
export interface ShutdownResult {
    readonly completed: boolean;
    readonly timedOut: boolean;
    readonly durationMs: number;
    readonly remainingEvents: number;
    readonly deadLetterCount: number;
    readonly stepErrors: readonly ShutdownStepError[];
}
/**
 * Check if the SDK is currently shutting down.
 * Used by capture paths and the queue to reject new events early.
 */
export declare function isSDKShuttingDown(): boolean;
/**
 * Register a hook to be called before shutdown begins.
 * Hooks run in registration order with a per-hook timeout.
 * Failed hooks are logged but do not abort shutdown.
 */
export declare function onBeforeShutdown(hook: () => Promise<void>): void;
/**
 * Graceful shutdown — flushes telemetry, tears down subsystems, and resets
 * all global state so a subsequent init() starts from a clean slate.
 *
 * Concurrent invocations share the same in-flight shutdown promise; the
 * second caller does not start a duplicate teardown.
 *
 * @param timeoutMs Maximum time to wait for flush/teardown. Defaults to
 *   the SDK's configured shutdownTimeoutMs (10s if unset).
 * @returns A ShutdownResult describing what happened. Never throws.
 */
export declare function shutdown(timeoutMs?: number): Promise<ShutdownResult>;
/**
 * Wait until all teardown work has released SDK-owned resources. A timed-out
 * public shutdown can finish cleanup in the background; init() uses this
 * barrier to prevent a new runtime from racing the previous one.
 * @internal
 */
export declare function waitForShutdownCompletion(): Promise<void>;
/**
 * Force-flush pending telemetry without tearing down the SDK.
 * Safe to call concurrently with regular event capture.
 */
export declare function flush(): Promise<void>;
/**
 * Emergency flush for crash scenarios (uncaughtException, SIGKILL).
 *
 * Drains only the event pipeline and transport queue with a hard timeout.
 * Does NOT shut down subsystems or tear down plugins — the process is
 * assumed to be terminating imminently.
 *
 * Design:
 *   - Best-effort: swallows all errors so it never makes a crash worse.
 *   - Bounded: hard timeout prevents indefinite process hang.
 *   - Lightweight: no subsystem teardown, no singleton resets.
 *
 * @param timeoutMs Maximum time to wait for transport drain. Default: 2000ms.
 */
export declare function crashFlush(timeoutMs?: number): Promise<void>;
/**
 * Register SIGTERM/SIGINT handlers for automatic graceful shutdown.
 * Idempotent: a second call without an intervening reset is a no-op.
 */
export declare function registerSignalHandlers(): void;
/**
 * Remove process signal handlers and reset module state.
 * Called automatically during shutdown; safe to call standalone.
 * @internal
 */
export declare function resetSignalHandlers(): void;
