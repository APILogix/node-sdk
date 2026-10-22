import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteConfigResponse } from '../types/config.js'
import type { InitResponse } from '../core/remote-config-client.js'
import { assertRemoteConfig } from '../core/config-validator.js'
import { getLogger } from '../utils/logger.js'

export interface CachedConfigPayload {
  readonly version: 1
  readonly cachedAt: string
  readonly projectId: string
  readonly environment: string
  readonly release: string
  readonly configRevision?: number | null | undefined
  readonly config: RemoteConfigResponse
}

function getCacheDir(): string {
  const lynkDir = join(process.cwd(), '.lynktrace')
  const pulseDir = join(process.cwd(), '.pulse')
  try {
    if (existsSync(lynkDir)) return lynkDir
    if (existsSync(pulseDir)) return pulseDir
  } catch {}
  return lynkDir
}

function getCacheFilePath(apiKey: string): string {
  const hash = createHash('sha256').update(apiKey).digest('hex')
  return join(getCacheDir(), `config-cache-${hash}.json`)
}

function getLegacyCacheFilePath(apiKey: string): string {
  const hash = createHash('sha256').update(apiKey).digest('hex')
  return join(join(process.cwd(), '.pulse'), `config-cache-${hash}.json`)
}

/**
 * @deprecated Disk-based configuration caching has been intentionally removed
 * from the SDK initialization and recovery lifecycle in favor of in-memory
 * configuration + asynchronous background recovery. This ensures 100% portability
 * across serverless, read-only, containerized, and permission-restricted environments.
 *
 * Save a validated RemoteConfigResponse to disk for cold-start LKG recovery.
 * Never writes raw API keys, Authorization headers, tokens, or credentials.
 * Asynchronous and fire-and-forget: errors are logged at debug level and swallowed.
 */
export async function saveConfigCache(apiKey: string, response: InitResponse): Promise<void> {
  if (!apiKey || !response.config) return

  try {
    const dir = getCacheDir()
    await mkdir(dir, { recursive: true })

    const payload: CachedConfigPayload = {
      version: 1,
      cachedAt: new Date().toISOString(),
      projectId: response.projectId,
      environment: response.environment,
      release: response.release,
      ...(response.configRevision !== undefined ? { configRevision: response.configRevision } : {}),
      config: response.config,
    }

    const filePath = getCacheFilePath(apiKey)
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
    getLogger().debug('Saved Last-Known-Good configuration cache to disk')
  } catch (error) {
    getLogger().debug('Failed to write configuration cache to disk', { error })
  }
}

/**
 * Load and validate a cached Last-Known-Good configuration from disk.
 * Returns null if the cache does not exist, cannot be read, or fails schema validation.
 */
export async function loadConfigCache(apiKey: string): Promise<InitResponse | null> {
  if (!apiKey) return null

  try {
    let filePath = getCacheFilePath(apiKey)
    let raw: string | null = null
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      filePath = getLegacyCacheFilePath(apiKey)
      raw = await readFile(filePath, 'utf8')
    }
    const parsed = JSON.parse(raw) as Partial<CachedConfigPayload>

    if (!parsed || parsed.version !== 1 || !parsed.config) {
      return null
    }

    // Validate the cached config using the authoritative schema validator
    assertRemoteConfig(parsed.config)

    const response: InitResponse = {
      success: true,
      projectId: parsed.projectId || parsed.config.sdk.projectId,
      environment: parsed.environment || parsed.config.sdk.environment,
      release: parsed.release || parsed.config.sdk.release,
      organizationId: '',
      config: parsed.config,
      ...(parsed.configRevision !== undefined ? { configRevision: parsed.configRevision } : {}),
    }

    getLogger().info('Loaded validated Last-Known-Good configuration from cache')
    return response
  } catch (error) {
    getLogger().debug('Could not load configuration cache', { error })
    return null
  }
}

/**
 * Remove cached configuration from disk (used during tests or key revocation).
 */
export async function clearConfigCache(apiKey: string): Promise<void> {
  if (!apiKey) return

  try {
    await unlink(getCacheFilePath(apiKey))
  } catch {}
  try {
    await unlink(getLegacyCacheFilePath(apiKey))
  } catch {}
}
