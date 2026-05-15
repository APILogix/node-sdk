/**
 * Returns a high-resolution monotonic nanosecond timestamp.
 * Suitable for measuring durations — immune to wall-clock drift.
 */
export declare function hrtimeNs(): bigint;
/**
 * Returns the current epoch time in milliseconds.
 */
export declare function epochMs(): number;
/**
 * Returns the current time as an ISO 8601 string.
 */
export declare function isoNow(): string;
/**
 * Computes duration in milliseconds between a hrtime start and now.
 */
export declare function durationMs(startNs: bigint): number;
/**
 * Returns a promise that resolves after the specified milliseconds.
 * Uses setTimeout internally — safe for event loop.
 */
export declare function sleep(ms: number): Promise<void>;
//# sourceMappingURL=time.d.ts.map