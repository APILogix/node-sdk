/**
 * @module memory-detector
 * @description Enterprise-grade automatic memory limit detection for the LynkTrace SDK.
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
import { readFileSync } from 'node:fs';
import * as v8 from 'node:v8';
import * as os from 'node:os';
import { getLogger } from './logger.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Minimum allowed effective memory limit in MB. */
const MIN_MEMORY_MB = 64;
/** Maximum allowed effective memory limit in MB (SAFETY_CEILINGS.maxMemoryMb). */
const MAX_MEMORY_MB = 1024;
/** Fallback raw limit when no other source is available. */
const FALLBACK_LIMIT_MB = 256;
/** Utilization factor applied to the raw detected limit. */
const UTILIZATION_FACTOR = 0.5;
/**
 * Threshold above which a cgroup value is treated as "unlimited" (1 TiB in bytes).
 * Kernel sentinels (> 1 TiB) indicate unconstrained host memory; detection falls through.
 */
const CGROUP_UNLIMITED_THRESHOLD = 1099511627776;
/**
 * Sentinel value used by cgroup v1 to indicate no limit.
 * Kernel commonly reports this for unlimited memory.
 */
const CGROUP_V1_UNLIMITED = 9223372036854771712;
/** cgroup v2 memory limit path. */
const CGROUP_V2_PATH = '/sys/fs/cgroup/memory.max';
/** cgroup v1 memory limit path. */
const CGROUP_V1_PATH = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
let cachedResult = null;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Convert bytes to megabytes (floored).
 */
function bytesToMb(bytes) {
    return Math.floor(bytes / (1024 * 1024));
}
/**
 * Compute the effective limit from a raw detected limit in MB.
 * Applies 50% utilization factor and clamps to [MIN_MEMORY_MB, MAX_MEMORY_MB].
 */
function computeEffectiveLimit(detectedLimitMb) {
    return Math.min(Math.max(Math.floor(detectedLimitMb * UTILIZATION_FACTOR), MIN_MEMORY_MB), MAX_MEMORY_MB);
}
/**
 * Attempt to read memory limit from cgroup v2.
 * @returns Limit in bytes, or `null` if unavailable / unlimited.
 */
function tryCgroupV2() {
    try {
        const raw = readFileSync(CGROUP_V2_PATH, 'utf-8').trim();
        // 'max' means unlimited in cgroup v2
        if (raw === 'max') {
            return null;
        }
        const value = Number(raw);
        if (Number.isNaN(value) || value <= 0) {
            return null;
        }
        // Treat values >= 8 GB as effectively unlimited
        if (value >= CGROUP_UNLIMITED_THRESHOLD) {
            return null;
        }
        return value;
    }
    catch {
        // Filesystem read failure — fall through
        return null;
    }
}
/**
 * Attempt to read memory limit from cgroup v1.
 * @returns Limit in bytes, or `null` if unavailable / unlimited.
 */
function tryCgroupV1() {
    try {
        const raw = readFileSync(CGROUP_V1_PATH, 'utf-8').trim();
        const value = Number(raw);
        if (Number.isNaN(value) || value <= 0) {
            return null;
        }
        // Kernel sentinel for unlimited
        if (value === CGROUP_V1_UNLIMITED) {
            return null;
        }
        // Treat values >= 8 GB as effectively unlimited
        if (value >= CGROUP_UNLIMITED_THRESHOLD) {
            return null;
        }
        return value;
    }
    catch {
        // Filesystem read failure — fall through
        return null;
    }
}
/**
 * Read the V8 heap size limit.
 * @returns Limit in bytes.
 */
function tryV8Heap() {
    return v8.getHeapStatistics().heap_size_limit;
}
/**
 * Read total system memory on Windows.
 * @returns Limit in bytes, or `null` if not on win32.
 */
function tryWindowsOs() {
    if (os.platform() !== 'win32') {
        return null;
    }
    return os.totalmem();
}
/**
 * Execute the full detection priority chain.
 */
function performDetection() {
    // 1. cgroup v2
    const cgroupV2 = tryCgroupV2();
    if (cgroupV2 !== null) {
        const detectedLimitMb = bytesToMb(cgroupV2);
        return {
            detectedLimitMb,
            effectiveLimitMb: computeEffectiveLimit(detectedLimitMb),
            source: 'cgroup-v2',
            confidence: 'high',
        };
    }
    // 2. cgroup v1
    const cgroupV1 = tryCgroupV1();
    if (cgroupV1 !== null) {
        const detectedLimitMb = bytesToMb(cgroupV1);
        return {
            detectedLimitMb,
            effectiveLimitMb: computeEffectiveLimit(detectedLimitMb),
            source: 'cgroup-v1',
            confidence: 'high',
        };
    }
    // 3. V8 heap limit
    const heapLimit = tryV8Heap();
    if (heapLimit > 0) {
        const detectedLimitMb = bytesToMb(heapLimit);
        return {
            detectedLimitMb,
            effectiveLimitMb: computeEffectiveLimit(detectedLimitMb),
            source: 'v8-heap',
            confidence: 'medium',
        };
    }
    // 4. Windows OS total memory
    const winMem = tryWindowsOs();
    if (winMem !== null && winMem > 0) {
        const detectedLimitMb = bytesToMb(winMem);
        return {
            detectedLimitMb,
            effectiveLimitMb: computeEffectiveLimit(detectedLimitMb),
            source: 'windows-os',
            confidence: 'low',
        };
    }
    // 5. Fallback
    return {
        detectedLimitMb: FALLBACK_LIMIT_MB,
        effectiveLimitMb: computeEffectiveLimit(FALLBACK_LIMIT_MB),
        source: 'fallback',
        confidence: 'low',
    };
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Detect the system memory limit using the priority chain.
 *
 * The result is cached after the first invocation. Subsequent calls return
 * the cached value without performing filesystem reads or system queries.
 *
 * @returns The detection result including raw limit, effective limit, source, and confidence.
 */
export function detectMemoryLimit() {
    if (cachedResult !== null) {
        return cachedResult;
    }
    const result = performDetection();
    cachedResult = result;
    // Log detection on first run
    try {
        const logger = getLogger();
        logger.info(`[memory-detector] Detected memory limit: ${result.detectedLimitMb} MB ` +
            `(effective: ${result.effectiveLimitMb} MB) via ${result.source} ` +
            `[confidence: ${result.confidence}]`);
    }
    catch {
        // Logger may not be available; never throw from detection.
    }
    return result;
}
/**
 * Resolve the `maxMemoryMb` configuration value.
 *
 * - If `userValue` is `'auto'`, runs automatic detection and returns `effectiveLimitMb`.
 * - If `userValue` is a number, it is clamped to [64, 1024] MB.
 *
 * @param userValue - User-provided value: either `'auto'` for automatic detection or a numeric MB value.
 * @returns Resolved memory limit in megabytes, safe for SDK use.
 */
export function resolveMaxMemoryMb(userValue) {
    if (userValue === 'auto') {
        return detectMemoryLimit().effectiveLimitMb;
    }
    // Clamp explicit numeric value to safety bounds
    return Math.min(Math.max(Math.floor(userValue), MIN_MEMORY_MB), MAX_MEMORY_MB);
}
/**
 * Clear the cached detection result.
 *
 * Intended for testing scenarios where detection needs to be re-run
 * with different environment conditions.
 */
export function clearMemoryDetectionCache() {
    cachedResult = null;
}
