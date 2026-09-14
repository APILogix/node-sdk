/**
 * Safe Environment Variable & .env File Loader
 *
 * Provides zero-dependency .env file loading for Node.js environments:
 * 1. Checks native Node.js >= 20.6.0 `process.loadEnvFile()`.
 * 2. Provides lightweight fallback parser for older Node runtimes or custom paths.
 * 3. Never throws; fails silently if .env is missing or inaccessible.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let envLoaded = false

/**
 * Automatically load environment variables from the current working directory's .env file.
 * Existing process.env variables take precedence and are never overwritten.
 */
export function loadEnvFileSafely(customPath?: string): void {
  if (typeof process === 'undefined' || !process.env) return
  if (envLoaded && !customPath) return

  // 1. Try native Node 20.6+ process.loadEnvFile
  if (!customPath && typeof (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile === 'function') {
    try {
      (process as unknown as { loadEnvFile: (path?: string) => void }).loadEnvFile()
      envLoaded = true
      return
    } catch {
      // .env missing or unreadable via native loader; fallback to manual check
    }
  }

  // 2. Lightweight fallback parser
  try {
    const envPath = customPath || join(process.cwd(), '.env')
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf8')
      parseAndApplyEnv(content)
      envLoaded = true
    }
  } catch {
    // Graceful no-op on read or permission errors
  }
}

/**
 * Parse .env content and populate process.env for unset keys.
 */
export function parseAndApplyEnv(content: string): void {
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const equalIndex = trimmed.indexOf('=')
    if (equalIndex === -1) continue

    const key = trimmed.slice(0, equalIndex).trim()
    let value = trimmed.slice(equalIndex + 1).trim()

    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    // Never overwrite existing environment variables
    if (key && process.env[key] === undefined) {
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
