/**
 * Returns a high-resolution monotonic nanosecond timestamp.
 * Suitable for measuring durations — immune to wall-clock drift.
 */
export function getHrtimeNs() {
    return process.hrtime.bigint();
}
export const hrtimeNs = getHrtimeNs;
/**
 * Returns the current epoch time in milliseconds.
 */
export function getEpochMs() {
    return Date.now();
}
export const epochMs = getEpochMs;
/**
 * Returns the current time as an ISO 8601 string.
 */
export function getIsoNow() {
    return new Date().toISOString();
}
export const isoNow = getIsoNow;
/**
 * Computes duration in milliseconds between a hrtime start and now.
 */
export function computeDurationMs(startNs) {
    const deltaNs = process.hrtime.bigint() - startNs;
    return Number(deltaNs / 1000000n);
}
export const durationMs = computeDurationMs;
/**
 * Returns a promise that resolves after the specified milliseconds.
 * Uses setTimeout internally — safe for event loop.
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
