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
import { readFile as fsReadFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { SourceMapConsumer } from 'source-map-js';
import { getLogger } from '../utils/logger.js';
const DEFAULT_MAX_CACHE_SIZE = 100;
const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes
const SOURCE_MAP_URL_REGEX = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/;
class SourceMapResolver {
    cache = new Map();
    loadingPromises = new Map();
    sourceMapPaths = [];
    allowRemoteSourceMaps = false;
    maxCacheSize = DEFAULT_MAX_CACHE_SIZE;
    cacheTtlMs = DEFAULT_CACHE_TTL_MS;
    embedSourceContent = false;
    initialized = false;
    hits = 0;
    misses = 0;
    errors = 0;
    configure(options = {}) {
        this.sourceMapPaths = options.sourceMapPaths ?? [];
        this.allowRemoteSourceMaps = options.allowRemoteSourceMaps ?? false;
        this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
        this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        this.embedSourceContent = options.embedSourceContent ?? false;
        this.initialized = true;
    }
    /**
     * Resolve source maps for all stack frames in an error.
     * Returns the original (de-obfuscated) frames.
     */
    async resolveStackFrames(frames) {
        if (!this.initialized || frames.length === 0)
            return frames;
        const resolved = [];
        for (const frame of frames) {
            const resolvedFrame = await this.resolveFrame(frame);
            resolved.push(resolvedFrame);
        }
        return resolved;
    }
    /**
     * Get source map resolver statistics.
     */
    getStats() {
        const total = this.hits + this.misses;
        return {
            initialized: this.initialized,
            cacheSize: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            errors: this.errors,
            hitRate: total > 0 ? Math.round((this.hits / total) * 100) / 100 : 0,
        };
    }
    /**
     * Clear the source map cache.
     */
    clearCache() {
        this.cache.clear();
        this.loadingPromises.clear();
    }
    // ─── Internal ─────────────────────────────────────────────────────────
    async resolveFrame(frame) {
        if (!frame.lineno || !frame.colno)
            return frame;
        const sourceMapUrl = await this.findSourceMapUrl(frame.filename);
        if (!sourceMapUrl) {
            this.misses++;
            return frame;
        }
        const entry = await this.loadSourceMap(sourceMapUrl, frame.filename);
        if (!entry) {
            this.misses++;
            return frame;
        }
        const mapped = this.lookupMapping(entry, frame.filename, frame.lineno, frame.colno - 1);
        if (!mapped) {
            this.misses++;
            return frame;
        }
        this.hits++;
        const resolvedFrame = {
            ...frame,
            filename: this.resolveSourcePath(entry.rawMap, mapped.source),
            lineno: mapped.line,
            colno: mapped.column + 1,
            function: mapped.name || frame.function,
        };
        if (this.embedSourceContent && entry.rawMap.sourcesContent) {
            const sourceIndex = entry.rawMap.sources.indexOf(mapped.source);
            if (sourceIndex >= 0 && entry.rawMap.sourcesContent[sourceIndex]) {
                const frameObj = resolvedFrame;
                frameObj['sourceContent'] = entry.rawMap.sourcesContent[sourceIndex];
            }
        }
        return resolvedFrame;
    }
    async findSourceMapUrl(filename) {
        try {
            const content = await fsReadFile(filename, { encoding: 'utf8' });
            const match = SOURCE_MAP_URL_REGEX.exec(content);
            if (!match)
                return null;
            const url = match[1];
            if (!url)
                return null;
            if (url.startsWith('data:'))
                return url;
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return this.allowRemoteSourceMaps ? url : null;
            }
            const resolvedPath = resolve(dirname(filename), url);
            return resolvedPath;
        }
        catch {
            return null;
        }
    }
    async loadSourceMap(sourceMapUrl, filename) {
        const cacheKey = sourceMapUrl.startsWith('data:')
            ? this.hashString(sourceMapUrl)
            : sourceMapUrl;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            // TTL check — evict stale entries
            if (Date.now() - cached.loadedAt > this.cacheTtlMs) {
                this.cache.delete(cacheKey);
            }
            else {
                cached.hitCount++;
                cached.lastAccessedAt = Date.now();
                return cached;
            }
        }
        let loadPromise = this.loadingPromises.get(cacheKey);
        if (loadPromise)
            return loadPromise;
        loadPromise = this.doLoadSourceMap(sourceMapUrl, filename);
        this.loadingPromises.set(cacheKey, loadPromise);
        try {
            const entry = await loadPromise;
            if (entry) {
                this.cache.set(cacheKey, entry);
                this.evictCache();
            }
            return entry;
        }
        finally {
            this.loadingPromises.delete(cacheKey);
        }
    }
    async doLoadSourceMap(sourceMapUrl, _filename) {
        const logger = getLogger();
        try {
            let rawJson = null;
            if (sourceMapUrl.startsWith('data:')) {
                const base64Match = sourceMapUrl.match(/^data:application\/json;[^,]*;base64,(.+)/);
                if (base64Match && base64Match[1]) {
                    rawJson = Buffer.from(base64Match[1], 'base64').toString('utf8');
                }
                else {
                    const jsonPart = sourceMapUrl.split(',')[1];
                    if (jsonPart) {
                        rawJson = decodeURIComponent(jsonPart);
                    }
                }
            }
            else if (sourceMapUrl.startsWith('http://') || sourceMapUrl.startsWith('https://')) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                try {
                    const response = await fetch(sourceMapUrl, { signal: controller.signal });
                    if (!response.ok)
                        return null;
                    rawJson = await response.text();
                }
                finally {
                    clearTimeout(timeoutId);
                }
            }
            else if (existsSync(sourceMapUrl)) {
                rawJson = await fsReadFile(sourceMapUrl, { encoding: 'utf8' });
            }
            else {
                // Search additional source map paths
                for (const searchPath of this.sourceMapPaths) {
                    const fullPath = join(searchPath, sourceMapUrl.replace(/^.*[\\/]/, ''));
                    if (existsSync(fullPath)) {
                        rawJson = await fsReadFile(fullPath, { encoding: 'utf8' });
                        break;
                    }
                }
            }
            if (!rawJson)
                return null;
            const rawMap = JSON.parse(rawJson);
            const consumer = new SourceMapConsumer(rawMap);
            return {
                consumer,
                rawMap,
                loadedAt: Date.now(),
                lastAccessedAt: Date.now(),
                hitCount: 1,
            };
        }
        catch (error) {
            this.errors++;
            logger.debug('Source map load failed', { sourceMapUrl, error });
        }
        return null;
    }
    /**
     * Look up the original location for a generated position using
     * source-map-js's SourceMapConsumer — handles all VLQ decoding,
     * binary search over segments, and source resolution internally.
     */
    lookupMapping(entry, _generatedFile, generatedLine, generatedColumn) {
        try {
            const position = entry.consumer.originalPositionFor({
                line: generatedLine,
                column: generatedColumn,
            });
            // source-map-js returns { source: null, ... } for unmapped positions
            if (!position.source)
                return null;
            return {
                source: position.source,
                line: position.line ?? generatedLine,
                column: position.column ?? generatedColumn,
                name: position.name ?? null,
            };
        }
        catch {
            return null;
        }
    }
    resolveSourcePath(rawMap, source) {
        if (rawMap.sourceRoot) {
            return rawMap.sourceRoot.replace(/\/$/, '') + '/' + source;
        }
        return source;
    }
    evictCache() {
        if (this.cache.size <= this.maxCacheSize)
            return;
        const sorted = Array.from(this.cache.entries())
            .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)
            .slice(0, this.cache.size - this.maxCacheSize);
        for (const [key] of sorted) {
            this.cache.delete(key);
        }
    }
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }
}
export const sourceMapResolver = new SourceMapResolver();
export { SourceMapResolver };
//# sourceMappingURL=source-map-resolver.js.map