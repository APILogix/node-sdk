/**
 * Source map support — de-obfuscates minified stack frames.
 *
 * Loads source maps from:
 * - Inline source maps (data URIs in sourceMappingURL)
 * - File-based source maps (relative/absolute paths)
 * - Remote source maps (HTTP URLs)
 *
 * Uses the `source-map-js` library for VLQ decoding and mapping lookup —
 * battle-tested, standards-compliant, used by PostCSS, Vite, and the
 * entire CSS toolchain ecosystem. This replaces the previous custom VLQ
 * decoder to eliminate maintainability and correctness risk.
 *
 * Enterprise features:
 * - Source map cache with LRU eviction + TTL-based expiry
 * - Concurrent loading with deduplication (one inflight load per map)
 * - Configurable source map discovery paths
 * - Original source content embedding
 * - Bounded cache growth
 * - Async-safe symbolication (no event-loop blocking)
 */
import type { StackFrame } from '../types/event.js';
interface SourceMapResolverOptions {
    /** Additional directories to search for source maps. */
    sourceMapPaths?: string[];
    /** Enable loading remote source maps via HTTP. Default: false. */
    allowRemoteSourceMaps?: boolean;
    /** Maximum source maps to cache. Default: 100. */
    maxCacheSize?: number;
    /** Embed original source content in resolved frames. Default: false. */
    embedSourceContent?: boolean;
    /** Cache TTL in milliseconds. Default: 300000 (5 minutes). */
    cacheTtlMs?: number;
}
declare class SourceMapResolver {
    private cache;
    private loadingPromises;
    private sourceMapPaths;
    private allowRemoteSourceMaps;
    private maxCacheSize;
    private cacheTtlMs;
    private embedSourceContent;
    private initialized;
    private hits;
    private misses;
    private errors;
    configure(options?: SourceMapResolverOptions): void;
    /**
     * Resolve source maps for all stack frames in an error.
     * Returns the original (de-obfuscated) frames.
     */
    resolveStackFrames(frames: StackFrame[]): Promise<StackFrame[]>;
    /**
     * Get source map resolver statistics.
     */
    getStats(): {
        initialized: boolean;
        cacheSize: number;
        hits: number;
        misses: number;
        errors: number;
        hitRate: number;
    };
    /**
     * Clear the source map cache.
     */
    clearCache(): void;
    /**
     * Reset all state — for testing and SDK lifecycle shutdown.
     */
    reset(): void;
    private resolveFrame;
    private findSourceMapUrl;
    private loadSourceMap;
    private doLoadSourceMap;
    /**
     * Look up the original location for a generated position using
     * source-map-js's SourceMapConsumer — handles all VLQ decoding,
     * binary search over segments, and source resolution internally.
     */
    private lookupMapping;
    private resolveSourcePath;
    private evictCache;
    /**
     * SSRF guard for remote source maps. Only plain http(s) URLs to public
     * hosts are fetchable — loopback, RFC-1918, link-local (cloud metadata
     * endpoints live at 169.254.169.254), multicast, and internal-suffix
     * hostnames are refused. This runs even when allowRemoteSourceMaps is on.
     */
    private isRemoteSourceMapUrlAllowed;
    /**
     * Path traversal guard — absolute paths must stay inside the app root
     * (process.cwd). Refuses `..` escapes and cross-drive absolute paths.
     */
    private isPathWithinAppRoot;
    private hashString;
}
export declare const sourceMapResolver: SourceMapResolver;
export { SourceMapResolver };
export type { SourceMapResolverOptions };
