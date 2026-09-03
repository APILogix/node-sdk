/**
 * Returns a high-resolution monotonic nanosecond timestamp.
 * Suitable for measuring durations — immune to wall-clock drift.
 */
export function hrtimeNs() {
    return process.hrtime.bigint();
}
/**
 * Returns the current epoch time in milliseconds.
 */
export function epochMs() {
    return Date.now();
}
/**
 * Returns the current time as an ISO 8601 string.
 */
export function isoNow() {
    return new Date().toISOString();
}
/**
 * Computes duration in milliseconds between a hrtime start and now.
 */
export function durationMs(startNs) {
    const deltaNs = process.hrtime.bigint() - startNs;
    return Number(deltaNs / 1000000n);
}
/**
 * Returns a promise that resolves after the specified milliseconds.
 * Uses setTimeout internally — safe for event loop.
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
