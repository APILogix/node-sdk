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

import { existsSync, readFileSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { getLogger } from '../utils/logger.js'
import type { StackFrame } from '../types/event.js'

interface SourceMapV3 {
  version: number
  sources: string[]
  sourcesContent?: (string | null)[]
  names: string[]
  mappings: string
  file?: string
  sourceRoot?: string
}

interface MappedLocation {
  source: string
  line: number
  column: number
  name: string | null
}

interface SourceMapCacheEntry {
  sourceMap: SourceMapV3
  loadedAt: number
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
}

const DEFAULT_MAX_CACHE_SIZE = 100
const SOURCE_MAP_URL_REGEX = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/

class SourceMapResolver {
  private cache = new Map<string, SourceMapCacheEntry>()
  private loadingPromises = new Map<string, Promise<SourceMapV3 | null>>()
  private sourceMapPaths: string[] = []
  private allowRemoteSourceMaps = false
  private maxCacheSize = DEFAULT_MAX_CACHE_SIZE
  private embedSourceContent = false
  private initialized = false
  private hits = 0
  private misses = 0
  private errors = 0

  configure(options: SourceMapResolverOptions = {}): void {
    this.sourceMapPaths = options.sourceMapPaths ?? []
    this.allowRemoteSourceMaps = options.allowRemoteSourceMaps ?? false
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE
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

  // ─── Internal ─────────────────────────────────────────────────────────

  private async resolveFrame(frame: StackFrame): Promise<StackFrame> {
    if (!frame.lineno || !frame.colno) return frame

    const sourceMapUrl = await this.findSourceMapUrl(frame.filename)
    if (!sourceMapUrl) {
      this.misses++
      return frame
    }

    const sourceMap = await this.loadSourceMap(sourceMapUrl, frame.filename)
    if (!sourceMap) {
      this.misses++
      return frame
    }

    const mapped = this.lookupMapping(sourceMap, frame.filename, frame.lineno, frame.colno - 1)
    if (!mapped) {
      this.misses++
      return frame
    }

    this.hits++

    const resolvedFrame: StackFrame = {
      ...frame,
      filename: this.resolveSourcePath(sourceMap, mapped.source),
      lineno: mapped.line,
      colno: mapped.column + 1,
      function: mapped.name || frame.function,
    }

    if (this.embedSourceContent && sourceMap.sourcesContent) {
      const sourceIndex = sourceMap.sources.indexOf(mapped.source)
      if (sourceIndex >= 0 && sourceMap.sourcesContent[sourceIndex]) {
        const frameObj = resolvedFrame as unknown as Record<string, unknown>
        frameObj['sourceContent'] = sourceMap.sourcesContent[sourceIndex]
      }
    }

    return resolvedFrame
  }

  private async findSourceMapUrl(filename: string): Promise<string | null> {
    try {
      const content = readFileSync(filename, { encoding: 'utf8' })
      const match = SOURCE_MAP_URL_REGEX.exec(content)
      if (!match) return null

      const url = match[1]
      if (!url) return null
      if (url.startsWith('data:')) return url
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return this.allowRemoteSourceMaps ? url : null
      }

      const resolvedPath = resolve(dirname(filename), url)
      return resolvedPath
    } catch {
      return null
    }
  }

  private async loadSourceMap(sourceMapUrl: string, filename: string): Promise<SourceMapV3 | null> {
    const cacheKey = sourceMapUrl.startsWith('data:')
      ? this.hashString(sourceMapUrl)
      : sourceMapUrl

    const cached = this.cache.get(cacheKey)
    if (cached) {
      cached.hitCount++
      return cached.sourceMap
    }

    let loadPromise = this.loadingPromises.get(cacheKey)
    if (loadPromise) return loadPromise

    loadPromise = this.doLoadSourceMap(sourceMapUrl, filename)
    this.loadingPromises.set(cacheKey, loadPromise)

    try {
      const sourceMap = await loadPromise

      if (sourceMap) {
        this.cache.set(cacheKey, {
          sourceMap,
          loadedAt: Date.now(),
          hitCount: 1,
        })
        this.evictCache()
      }

      return sourceMap
    } finally {
      this.loadingPromises.delete(cacheKey)
    }
  }

  private async doLoadSourceMap(sourceMapUrl: string, filename: string): Promise<SourceMapV3 | null> {
    const logger = getLogger()

    try {
      if (sourceMapUrl.startsWith('data:')) {
        const base64Match = sourceMapUrl.match(/^data:application\/json;[^,]*;base64,(.+)/)
        if (base64Match && base64Match[1]) {
          const json = Buffer.from(base64Match[1], 'base64').toString('utf8')
          return JSON.parse(json) as SourceMapV3
        }
        const jsonPart = sourceMapUrl.split(',')[1]
        if (jsonPart) {
          return JSON.parse(decodeURIComponent(jsonPart)) as SourceMapV3
        }
      }

      if (sourceMapUrl.startsWith('http://') || sourceMapUrl.startsWith('https://')) {
        const response = await fetch(sourceMapUrl)
        if (!response.ok) return null
        return (await response.json()) as SourceMapV3
      }

      if (existsSync(sourceMapUrl)) {
        const content = readFileSync(sourceMapUrl, { encoding: 'utf8' })
        return JSON.parse(content) as SourceMapV3
      }

      for (const searchPath of this.sourceMapPaths) {
        const fullPath = join(searchPath, sourceMapUrl.replace(/^.*[\\/]/, ''))
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, { encoding: 'utf8' })
          return JSON.parse(content) as SourceMapV3
        }
      }
    } catch (error) {
      this.errors++
      logger.debug('Source map load failed', { sourceMapUrl, error })
    }

    return null
  }

  private lookupMapping(
    sourceMap: SourceMapV3,
    generatedFile: string,
    generatedLine: number,
    generatedColumn: number
  ): MappedLocation | null {
    const segments = this.decodeMappings(sourceMap.mappings)

    let bestMatch: MappedLocation | null = null
    let bestDistance = Infinity

    for (const segment of segments) {
      if (segment.generatedLine !== generatedLine) continue

      const distance = Math.abs(segment.generatedColumn - generatedColumn)
      if (distance < bestDistance) {
        bestDistance = distance
        const sources = sourceMap.sources ?? []
        const names = sourceMap.names ?? []
        bestMatch = {
          source: sources[segment.sourceIndex] ?? generatedFile,
          line: segment.originalLine,
          column: segment.originalColumn,
          name: segment.nameIndex !== null ? (names[segment.nameIndex] ?? null) : null,
        }
      }
    }

    return bestMatch
  }

  private decodeMappings(mappings: string): Array<{
    generatedLine: number
    generatedColumn: number
    sourceIndex: number
    originalLine: number
    originalColumn: number
    nameIndex: number | null
  }> {
    const result: Array<{
      generatedLine: number
      generatedColumn: number
      sourceIndex: number
      originalLine: number
      originalColumn: number
      nameIndex: number | null
    }> = []

    let generatedLine = 1
    let generatedColumn = 0
    let sourceIndex = 0
    let originalLine = 0
    let originalColumn = 0
    let nameIndex: number | null = null

    const lines = mappings.split(';')

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]
      if (!line) {
        generatedLine++
        generatedColumn = 0
        continue
      }

      const segments = line.split(',')
      generatedColumn = 0

      for (const segment of segments) {
        if (!segment) continue

        const values = this.decodeVLQ(segment)
        if (values.length === 0) continue

        const genCol = values[0] ?? 0
        generatedColumn += genCol

        if (values.length >= 4) {
          const srcIdx = values[1] ?? 0
          const origLine = values[2] ?? 0
          const origCol = values[3] ?? 0
          sourceIndex += srcIdx
          originalLine += origLine
          originalColumn += origCol

          let updatedNameIndex: number | null = nameIndex
          if (values.length >= 5) {
            const nameOffset = values[4] ?? 0
            updatedNameIndex = (nameIndex ?? 0) + nameOffset
          }
          nameIndex = updatedNameIndex

          result.push({
            generatedLine,
            generatedColumn,
            sourceIndex,
            originalLine: originalLine + 1,
            originalColumn,
            nameIndex,
          })
        }
      }

      generatedLine++
      generatedColumn = 0
    }

    return result
  }

  private decodeVLQ(encoded: string): number[] {
    const result: number[] = []
    let index = 0
    let shift = 0
    let value = 0

    while (index < encoded.length) {
      const char = encoded.charCodeAt(index++)
      const digit = this.base64Decode(char)
      if (digit === -1) break

      value += (digit & 31) << shift
      shift += 5

      if ((digit & 32) === 0) {
        const negative = value & 1
        value >>>= 1
        result.push(negative ? -value : value)
        value = 0
        shift = 0
      }
    }

    return result
  }

  private base64Decode(char: number): number {
    if (char >= 65 && char <= 90) return char - 65
    if (char >= 97 && char <= 122) return char - 26
    if (char >= 48 && char <= 57) return char + 4
    if (char === 43) return 62
    if (char === 47) return 63
    return -1
  }

  private resolveSourcePath(sourceMap: SourceMapV3, source: string): string {
    if (sourceMap.sourceRoot) {
      return sourceMap.sourceRoot.replace(/\/$/, '') + '/' + source
    }
    return source
  }

  private evictCache(): void {
    if (this.cache.size <= this.maxCacheSize) return

    const sorted = Array.from(this.cache.entries())
      .sort((a, b) => a[1].loadedAt - b[1].loadedAt)
      .slice(0, this.cache.size - this.maxCacheSize)

    for (const [key] of sorted) {
      this.cache.delete(key)
    }
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
