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

import { readFile as fsReadFile } from 'fs/promises'
import { resolve, dirname, join, relative, isAbsolute, sep } from 'path'
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js'
import { getLogger } from '../utils/logger.js'
import type { StackFrame } from '../types/event.js'
import { isTrustedSourceContextFile } from './source-context.js'

interface MappedLocation {
  source: string
  line: number
  column: number
  name: string | null
}

interface SourceMapCacheEntry {
  consumer: SourceMapConsumer
  rawMap: RawSourceMap
  loadedAt: number
  lastAccessedAt: number
  hitCount: number
}

interface SourceMapResolverOptions {
  /** Additional directories to search for source maps. */
  sourceMapPaths?: string[]
  /** Enable loading remote source maps via HTTP. Default: false. */
  allowRemoteSourceMaps?: boolean
  /** Maximum source maps to cache. Default: 100. */
  maxCacheSize?: number
  /** Embed original source content in resolved frames. Default: false. */
  embedSourceContent?: boolean
  /** Cache TTL in milliseconds. Default: 300000 (5 minutes). */
  cacheTtlMs?: number
}

const DEFAULT_MAX_CACHE_SIZE = 100
const DEFAULT_CACHE_TTL_MS = 300_000 // 5 minutes
const SOURCE_MAP_URL_REGEX = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/
const MAX_SOURCE_MAP_SIZE_BYTES = 16 * 1024 * 1024 // 16 MiB

class SourceMapResolver {
  private cache = new Map<string, SourceMapCacheEntry>()
  private loadingPromises = new Map<string, Promise<SourceMapCacheEntry | null>>()
  private sourceMapPaths: string[] = []
  private allowRemoteSourceMaps = false
  private maxCacheSize = DEFAULT_MAX_CACHE_SIZE
  private cacheTtlMs = DEFAULT_CACHE_TTL_MS
  private embedSourceContent = false
  private initialized = false
  private hits = 0
  private misses = 0
  private errors = 0

  configure(options: SourceMapResolverOptions = {}): void {
    this.sourceMapPaths = options.sourceMapPaths ?? []
    this.allowRemoteSourceMaps = options.allowRemoteSourceMaps ?? false
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.embedSourceContent = options.embedSourceContent ?? false
    this.initialized = true
  }

  /**
   * Resolve source maps for all stack frames in an error.
   * Returns the original (de-obfuscated) frames.
   */
  async resolveStackFrames(frames: StackFrame[]): Promise<StackFrame[]> {
    if (!this.initialized || frames.length === 0) return frames

    const resolved: StackFrame[] = []

    for (const frame of frames) {
      const resolvedFrame = await this.resolveFrame(frame)
      resolved.push(resolvedFrame)
    }

    return resolved
  }

  /**
   * Get source map resolver statistics.
   */
  getStats(): {
    initialized: boolean
    cacheSize: number
    hits: number
    misses: number
    errors: number
    hitRate: number
  } {
    const total = this.hits + this.misses
    return {
      initialized: this.initialized,
      cacheSize: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) / 100 : 0,
    }
  }

  /**
   * Clear the source map cache.
   */
  clearCache(): void {
    this.cache.clear()
    this.loadingPromises.clear()
  }

  /**
   * Reset all state — for testing and SDK lifecycle shutdown.
   */
  reset(): void {
    this.clearCache()
    this.sourceMapPaths = []
    this.allowRemoteSourceMaps = false
    this.maxCacheSize = DEFAULT_MAX_CACHE_SIZE
    this.cacheTtlMs = DEFAULT_CACHE_TTL_MS
    this.embedSourceContent = false
    this.initialized = false
    this.hits = 0
    this.misses = 0
    this.errors = 0
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private async resolveFrame(frame: StackFrame): Promise<StackFrame> {
    // Stack text is caller-controlled. Only inspect source files derived from
    // an actual loaded application frame; this also protects source-map URL
    // discovery from fabricated paths such as /dev/zero or database.js.
    if (!frame.lineno || !frame.colno || !isTrustedSourceContextFile(frame.filename)) return frame

    const sourceMapUrl = await this.findSourceMapUrl(frame.filename)
    if (!sourceMapUrl) {
      this.misses++
      return frame
    }

    const entry = await this.loadSourceMap(sourceMapUrl, frame.filename)
    if (!entry) {
      this.misses++
      return frame
    }

    const mapped = this.lookupMapping(entry, frame.filename, frame.lineno, frame.colno - 1)
    if (!mapped) {
      this.misses++
      return frame
    }

    this.hits++

    const resolvedFrame: StackFrame = {
      ...frame,
      filename: this.resolveSourcePath(entry.rawMap, mapped.source),
      lineno: mapped.line,
      colno: mapped.column + 1,
      function: mapped.name || frame.function,
    }

    if (this.embedSourceContent && entry.rawMap.sourcesContent) {
      const sourceIndex = entry.rawMap.sources.indexOf(mapped.source)
      if (sourceIndex >= 0 && entry.rawMap.sourcesContent[sourceIndex]) {
        const frameObj = resolvedFrame as unknown as Record<string, unknown>
        frameObj['sourceContent'] = entry.rawMap.sourcesContent[sourceIndex]
      }
    }

    return resolvedFrame
  }

  private async findSourceMapUrl(filename: string): Promise<string | null> {
    try {
      const content = await fsReadFile(filename, { encoding: 'utf8' })
      const match = SOURCE_MAP_URL_REGEX.exec(content)
      if (!match) return null

      const url = match[1]
      if (!url) return null
      if (url.startsWith('data:')) return url
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return this.allowRemoteSourceMaps && this.isRemoteSourceMapUrlAllowed(url) ? url : null
      }

      // Path traversal guard: a compromised dependency could ship
      // `sourceMappingURL=../../../../etc/passwd`. Only resolve map files
      // inside the application root.
      const resolvedPath = resolve(dirname(filename), url)
      if (!this.isPathWithinAppRoot(resolvedPath)) return null
      return resolvedPath
    } catch {
      return null
    }
  }

  private async loadSourceMap(sourceMapUrl: string, filename: string): Promise<SourceMapCacheEntry | null> {
    const cacheKey = sourceMapUrl.startsWith('data:')
      ? this.hashString(sourceMapUrl)
      : sourceMapUrl

    const cached = this.cache.get(cacheKey)
    if (cached) {
      // TTL check — evict stale entries
      if (Date.now() - cached.loadedAt > this.cacheTtlMs) {
        this.cache.delete(cacheKey)
      } else {
        cached.hitCount++
        cached.lastAccessedAt = Date.now()
        return cached
      }
    }

    let loadPromise = this.loadingPromises.get(cacheKey)
    if (loadPromise) return loadPromise

    loadPromise = this.doLoadSourceMap(sourceMapUrl, filename)
    this.loadingPromises.set(cacheKey, loadPromise)

    try {
      const entry = await loadPromise

      if (entry) {
        this.cache.set(cacheKey, entry)
        this.evictCache()
      }

      return entry
    } finally {
      this.loadingPromises.delete(cacheKey)
    }
  }

  private async doLoadSourceMap(sourceMapUrl: string, _filename: string): Promise<SourceMapCacheEntry | null> {
    const logger = getLogger()

    try {
      let rawJson: string | null = null

      if (sourceMapUrl.startsWith('data:')) {
        const base64Match = sourceMapUrl.match(/^data:application\/json;[^,]*;base64,(.+)/)
        if (base64Match && base64Match[1]) {
          rawJson = Buffer.from(base64Match[1], 'base64').toString('utf8')
        } else {
          const jsonPart = sourceMapUrl.split(',')[1]
          if (jsonPart) {
            rawJson = decodeURIComponent(jsonPart)
          }
        }
      } else if (sourceMapUrl.startsWith('http://') || sourceMapUrl.startsWith('https://')) {
        // Defense in depth: re-validate before any network egress, even
        // though findSourceMapUrl already gated this URL.
        if (!this.isRemoteSourceMapUrlAllowed(sourceMapUrl)) return null
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000)
        timeoutId.unref?.()
        try {
          const response = await fetch(sourceMapUrl, {
            signal: controller.signal,
            redirect: 'manual',
          })
          // Reject redirects to prevent SSRF via attacker-controlled stack
          // filenames. The expected source map is at the exact URL.
          if (response.status >= 300 && response.status < 400) return null
          if (!response.ok) return null
          const contentLength = response.headers.get('content-length')
          if (contentLength && parseInt(contentLength, 10) > MAX_SOURCE_MAP_SIZE_BYTES) return null
          rawJson = await response.text()
          if (Buffer.byteLength(rawJson, 'utf8') > MAX_SOURCE_MAP_SIZE_BYTES) return null
        } finally {
          clearTimeout(timeoutId)
        }
      } else if (this.isPathWithinAppRoot(sourceMapUrl)) {
        try {
          rawJson = await fsReadFile(sourceMapUrl, { encoding: 'utf8' })
        } catch {
          // File not found or unreadable, fall through to additional search paths
        }
      }
      if (!rawJson && !sourceMapUrl.startsWith('http://') && !sourceMapUrl.startsWith('https://')) {
        // Search additional source map paths
        for (const searchPath of this.sourceMapPaths) {
          const fullPath = join(searchPath, sourceMapUrl.replace(/^.*[\\/]/, ''))
          try {
            rawJson = await fsReadFile(fullPath, { encoding: 'utf8' })
            break
          } catch {
            // Not in this search path, try next
          }
        }
      }

      if (!rawJson) return null

      const rawMap = JSON.parse(rawJson) as RawSourceMap
      const consumer = new SourceMapConsumer(rawMap)

      return {
        consumer,
        rawMap,
        loadedAt: Date.now(),
        lastAccessedAt: Date.now(),
        hitCount: 1,
      }
    } catch (error) {
      this.errors++
      logger.debug('Source map load failed', { sourceMapUrl, error })
    }

    return null
  }

  /**
   * Look up the original location for a generated position using
   * source-map-js's SourceMapConsumer — handles all VLQ decoding,
   * binary search over segments, and source resolution internally.
   */
  private lookupMapping(
    entry: SourceMapCacheEntry,
    _generatedFile: string,
    generatedLine: number,
    generatedColumn: number
  ): MappedLocation | null {
    try {
      const position = entry.consumer.originalPositionFor({
        line: generatedLine,
        column: generatedColumn,
      })

      // source-map-js returns { source: null, ... } for unmapped positions
      if (!position.source) return null

      return {
        source: position.source,
        line: position.line ?? generatedLine,
        column: position.column ?? generatedColumn,
        name: position.name ?? null,
      }
    } catch {
      return null
    }
  }

  private resolveSourcePath(rawMap: RawSourceMap, source: string): string {
    if (rawMap.sourceRoot) {
      return rawMap.sourceRoot.replace(/\/$/, '') + '/' + source
    }
    return source
  }

  private evictCache(): void {
    // Evict one least-recently-accessed entry per call via linear scan —
    // O(n) worst case, amortized O(1) at steady state since inserts add a
    // single entry at a time. Avoids the previous O(n log n) full sort on
    // every insert past capacity.
    while (this.cache.size > this.maxCacheSize) {
      let oldestKey: string | null = null
      let oldestAccess = Infinity
      for (const [key, entry] of this.cache) {
        if (entry.lastAccessedAt < oldestAccess) {
          oldestAccess = entry.lastAccessedAt
          oldestKey = key
        }
      }
      if (oldestKey === null) return
      this.cache.delete(oldestKey)
    }
  }

  /**
   * SSRF guard for remote source maps. Only plain http(s) URLs to public
   * hosts are fetchable — loopback, RFC-1918, link-local (cloud metadata
   * endpoints live at 169.254.169.254), multicast, and internal-suffix
   * hostnames are refused. This runs even when allowRemoteSourceMaps is on.
   */
  private isRemoteSourceMapUrlAllowed(rawUrl: string): boolean {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return false
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

    const hostname = parsed.hostname.toLowerCase()
    if (!hostname) return false
    if (/^(localhost|.*\.(local|internal|lan|home|corp))$/.test(hostname)) return false

    // Literal IPv4 — block loopback, private, link-local, multicast ranges.
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
    if (ipv4) {
      const a = Number(ipv4[1])
      const b = Number(ipv4[2])
      if (a === 0 || a === 10 || a === 127) return false
      if (a === 169 && b === 254) return false
      if (a === 172 && b >= 16 && b <= 31) return false
      if (a === 192 && b === 168) return false
      if (a >= 224) return false
    }

    // Literal IPv6 (URL.hostname keeps brackets) — loopback, link-local,
    // and unique-local addresses.
    const v6 = hostname.replace(/^\[|\]$/g, '')
    if (v6 === '::1' || v6 === '::' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) {
      return false
    }

    return true
  }

  /**
   * Path traversal guard — absolute paths must stay inside the app root
   * (process.cwd). Refuses `..` escapes and cross-drive absolute paths.
   */
  private isPathWithinAppRoot(absolutePath: string): boolean {
    const appRoot = process.cwd()
    const rel = relative(appRoot, absolutePath)
    if (rel === '') return false
    if (rel.startsWith('..') || isAbsolute(rel)) return false
    // Windows: reject paths resolved onto a different drive/share root.
    return !rel.split(sep).includes('..')
  }

  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(36)
  }
}

export const sourceMapResolver = new SourceMapResolver()
export { SourceMapResolver }
export type { SourceMapResolverOptions }
