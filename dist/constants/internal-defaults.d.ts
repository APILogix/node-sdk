/**
 * SDK-internal defaults that used to live in the wire schema but aren't
 * worth giving the backend remote control over. Things like:
 *
 *   - `Error.stackTraceLimit` (process-global; one value for the whole SDK).
 *   - "attach source context to error stacks" (always-on quality-of-life).
 *   - `maxSpansPerTrace` (already capped by `LimitsConfig.maxSpansPerTrace`).
 *   - `ignoredRoutes` / `ignoredMethods` for tracing (now expressed as
 *     `sampling.routes["/health"].traces = 0` per the new schema).
 *
 * Subsystems that previously read these from `config.errors`,
 * `config.tracing`, `config.logging`, etc. now read from this module
 * instead. If the backend ever needs to override one, we promote it back
 * into the schema with a careful migration.
 *
 * Keeping these in one file makes them easy to audit during code review
 * and easy to override in tests.
 */
/** Behaviour for unhandled errors and console capture. */
export declare const ERROR_DEFAULTS: Readonly<{
    readonly captureUnhandledRejections: true;
    readonly captureUncaughtExceptions: true;
    readonly captureConsoleErrors: true;
    /** Node-side `Error.stackTraceLimit` — frames beyond this are dropped. */
    readonly stackTraceLimit: 50;
    /** Whether to read source files and attach surrounding lines to stack frames. */
    readonly attachSourceContext: true;
    readonly grouping: Readonly<{
        enabled: true;
        normalizePaths: true;
    }>;
}>;
/** Console capture and log-event sizing. */
export declare const LOGGING_DEFAULTS: Readonly<{
    readonly enabled: true;
    readonly captureConsole: true;
    /** Log levels to forward to telemetry. Anything outside this list is ignored. */
    readonly levels: readonly string[];
    /** Truncate log messages above this many bytes. */
    readonly maxLogSize: number;
}>;
/**
 * Profiling defaults. The remote-config `features.profiling` boolean and
 * `killswitches.disableProfiling` are still authoritative for whether
 * profiling runs at all.
 */
export declare const PROFILING_DEFAULTS: Readonly<{
    readonly cpu: true;
    readonly heap: true;
    /** Hard upper bound on a single profile's duration. */
    readonly maxDurationMs: 30000;
}>;
/**
 * Tracing internals. Anything that's not in the wire schema lives here.
 *
 * Note: `ignoredRoutes` / `ignoredMethods` are intentionally **not** in
 * this file — the new schema expresses them as `sampling.routes["/path"]`
 * with rates set to zero, which is uniform across all event types.
 */
export declare const TRACING_DEFAULTS: Readonly<{
    /**
     * Hard upper bound on spans within a single trace. Independent of
     * `LimitsConfig.maxSpansPerTrace`, which is a tenant-level cap; this
     * is the SDK-level safety stop.
     */
    readonly maxSpansPerTrace: 5000;
    /** Per-span attribute count cap (mirrors `LimitsConfig.maxSpanAttributes`). */
    readonly maxSpanAttributes: 200;
    /** Maximum wall-clock duration of a single trace before it is force-finished. */
    readonly maxTraceDurationMs: number;
    /** W3C TraceContext / Baggage propagation toggles — all on by default. */
    readonly propagation: Readonly<{
        w3c: true;
        baggage: true;
        b3: false;
    }>;
}>;
