/**
 * Returns a high-resolution monotonic nanosecond timestamp.
 * Suitable for measuring durations — immune to wall-clock drift.
 */
export declare function getHrtimeNs(): bigint;
export declare const hrtimeNs: typeof getHrtimeNs;
/**
 * Returns the current epoch time in milliseconds.
 */
export declare function getEpochMs(): number;
export declare const epochMs: typeof getEpochMs;
/**
 * Returns the current time as an ISO 8601 string.
 */
export declare function getIsoNow(): string;
export declare const isoNow: typeof getIsoNow;
/**
 * Computes duration in milliseconds between a hrtime start and now.
 */
export declare function computeDurationMs(startNs: bigint): number;
export declare const durationMs: typeof computeDurationMs;
/**
 * Returns a promise that resolves after the specified milliseconds.
 * Uses setTimeout internally — safe for event loop.
 */
export declare function sleep(ms: number): Promise<void>;
