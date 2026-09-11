/**
 * @module memory-detector
 * @description Enterprise-grade automatic memory limit detection for the Pulse SDK.
 *
 * Detection priority chain (highest to lowest):
 * 1. cgroup v2 — `/sys/fs/cgroup/memory.max`
 * 2. cgroup v1 — `/sys/fs/cgroup/memory/memory.limit_in_bytes`
 * 3. V8 heap  — `v8.getHeapStatistics().heap_size_limit`
 * 4. Windows  — `os.totalmem()` on win32
 * 5. Fallback — hardcoded 256 MB
 *
 * The effective limit applies a 50% utilization factor clamped to [64, 1024] MB.
 * Detection is cached after first invocation; call `clearMemoryDetectionCache()` in tests.
 */
/**
 * Describes which detection source provided the memory limit.
 */
export type MemoryDetectionSource = 'cgroup-v2' | 'cgroup-v1' | 'v8-heap' | 'windows-os' | 'fallback';
/**
 * Result of automatic memory limit detection.
 */
export interface MemoryDetectionResult {
    /** Raw detected memory limit in megabytes before any clamping or utilization factor. */
    detectedLimitMb: number;
    /** Effective limit after applying 50% utilization and [64, 1024] MB safety clamp. */
    effectiveLimitMb: number;
    /** Which detection source was used. */
    source: MemoryDetectionSource;
    /** Confidence in the accuracy of the detected limit. */
    confidence: 'high' | 'medium' | 'low';
}
/**
 * Detect the system memory limit using the priority chain.
 *
 * The result is cached after the first invocation. Subsequent calls return
 * the cached value without performing filesystem reads or system queries.
 *
 * @returns The detection result including raw limit, effective limit, source, and confidence.
 */
export declare function detectMemoryLimit(): MemoryDetectionResult;
/**
 * Resolve the `maxMemoryMb` configuration value.
 *
 * - If `userValue` is `'auto'`, runs automatic detection and returns `effectiveLimitMb`.
 * - If `userValue` is a number, it is clamped to [64, 1024] MB.
 *
 * @param userValue - User-provided value: either `'auto'` for automatic detection or a numeric MB value.
 * @returns Resolved memory limit in megabytes, safe for SDK use.
 */
export declare function resolveMaxMemoryMb(userValue: 'auto' | number): number;
/**
 * Clear the cached detection result.
 *
 * Intended for testing scenarios where detection needs to be re-run
 * with different environment conditions.
 */
export declare function clearMemoryDetectionCache(): void;
