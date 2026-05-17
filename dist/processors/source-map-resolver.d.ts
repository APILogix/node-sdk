/**
 * Source map support — de-obfuscates minified stack frames.
 *
 * Loads source maps from:
 * - Inline source maps (data URIs in sourceMappingURL)
 * - File-based source maps (relative/absolute paths)
 * - Remote source maps (HTTP URLs)
 *
 * Uses the source-map library for VLQ decoding and mapping lookup.
 * Falls back gracefully if source maps are unavailable.
 *
 * Enterprise features:
 * - Source map cache with LRU eviction
 * - Concurrent loading with deduplication
 * - Configurable source map discovery paths
 * - Original source content embedding
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
}
declare class SourceMapResolver {
    private cache;
    private loadingPromises;
    private sourceMapPaths;
    private allowRemoteSourceMaps;
    private maxCacheSize;
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
    private resolveFrame;
    private findSourceMapUrl;
    private loadSourceMap;
    private doLoadSourceMap;
    private lookupMapping;
    private decodeMappings;
    private decodeVLQ;
    private base64Decode;
    private resolveSourcePath;
    private evictCache;
    private hashString;
}
export declare const sourceMapResolver: SourceMapResolver;
export { SourceMapResolver };
export type { SourceMapResolverOptions };
//# sourceMappingURL=source-map-resolver.d.ts.map