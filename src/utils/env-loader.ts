/**
 * Safe Environment Variable & .env File Loader
 *
 * Provides zero-dependency .env file loading for Node.js environments:
 * 1. Safely checks for local .env files without unexpected host side-effects (SEC-10).
 * 2. Only populates Pulse-scoped variables (PULSE_* and SDK_BASE_URL) during implicit loading.
 * 3. Never overwrites existing process.env variables.
 * 4. Never throws; fails silently if .env is missing or inaccessible.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let envLoaded = false

/**
 * Checks whether an environment variable key is scoped to the Pulse SDK.
 */
export function isPulseScopedKey(key: string): boolean {
  return key.startsWith('PULSE_') || key === 'SDK_BASE_URL'
}

/**
 * Automatically load environment variables from the current working directory's .env file.
 * Existing process.env variables take precedence and are never overwritten.
 * Implicit loading only extracts Pulse-scoped variables to avoid unexpected host side effects (SEC-10).
 */
export function loadEnvFileSafely(customPath?: string): void {
  if (typeof process === 'undefined' || !process.env) return
  if (envLoaded && !customPath) return

  try {
    const envPath = customPath || join(process.cwd(), '.env')
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf8')
      const pulseOnly = !customPath && process.env['PULSE_LOAD_ALL_ENV'] !== 'true'
      parseAndApplyEnv(content, { pulseOnly })
      envLoaded = true
    }
  } catch {
    // Graceful no-op on read or permission errors
  }
}

/**
 * Parse .env content and populate process.env for unset keys.
 */
export function parseAndApplyEnv(content: string, options: { pulseOnly?: boolean } = {}): void {
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const equalIndex = trimmed.indexOf('=')
    if (equalIndex === -1) continue

    const key = trimmed.slice(0, equalIndex).trim()
    if (!key) continue

    // In pulseOnly mode, ignore host application variables
    if (options.pulseOnly && !isPulseScopedKey(key)) {
      continue
    }

    let value = trimmed.slice(equalIndex + 1).trim()

    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // Never overwrite existing environment variables
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

/**
 * Reset loader state (primarily for test isolation).
 * @internal
 */
export function resetEnvLoaderState(): void {
  envLoaded = false
}
