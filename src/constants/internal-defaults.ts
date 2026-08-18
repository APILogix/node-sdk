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
export const ERROR_DEFAULTS = Object.freeze({
  captureUnhandledRejections: true,
  captureUncaughtExceptions: true,
  captureConsoleErrors: true,
  /** Node-side `Error.stackTraceLimit` — frames beyond this are dropped. */
  stackTraceLimit: 50,
  /** Whether to read source files and attach surrounding lines to stack frames. */
  attachSourceContext: true,
  grouping: Object.freeze({
    enabled: true,
    normalizePaths: true,
  }),
} as const)

/** Console capture and log-event sizing. */
export const LOGGING_DEFAULTS = Object.freeze({
  enabled: true,
  captureConsole: true,
  /** Log levels to forward to telemetry. Anything outside this list is ignored. */
  levels: ['debug', 'info', 'warning', 'warn', 'error', 'fatal'] as readonly string[],
  /** Truncate log messages above this many bytes. */
  maxLogSize: 32 * 1024,
} as const)

/**
 * Profiling defaults. The remote-config `features.profiling` boolean and
 * `killswitches.disableProfiling` are still authoritative for whether
 * profiling runs at all.
 */
export const PROFILING_DEFAULTS = Object.freeze({
  cpu: true,
  heap: true,
  /** Hard upper bound on a single profile's duration. */
  maxDurationMs: 30_000,
} as const)

/**
 * Tracing internals. Anything that's not in the wire schema lives here.
 *
 * Note: `ignoredRoutes` / `ignoredMethods` are intentionally **not** in
 * this file — the new schema expresses them as `sampling.routes["/path"]`
 * with rates set to zero, which is uniform across all event types.
 */
export const TRACING_DEFAULTS = Object.freeze({
  /**
   * Hard upper bound on spans within a single trace. Independent of
   * `LimitsConfig.maxSpansPerTrace`, which is a tenant-level cap; this
   * is the SDK-level safety stop.
   */
  maxSpansPerTrace: 5_000,
  /** Per-span attribute count cap (mirrors `LimitsConfig.maxSpanAttributes`). */
  maxSpanAttributes: 200,
  /** Maximum wall-clock duration of a single trace before it is force-finished. */
  maxTraceDurationMs: 5 * 60 * 1000,
  /** W3C TraceContext / Baggage propagation toggles — all on by default. */
  propagation: Object.freeze({
    w3c: true,
    baggage: true,
    b3: false,
  }),
} as const)

