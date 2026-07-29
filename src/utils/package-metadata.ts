import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SDKInitOptions } from '../types/config.js'

export interface ApplicationPackageMetadata {
  readonly name: string
  readonly version: string
  readonly packageJsonPath?: string
}

/** Resolve consuming-app identity once during SDK initialization. Never throws. */
export function resolveApplicationPackage(options: SDKInitOptions): ApplicationPackageMetadata {
  const discovered = readPackage(options.packageJsonPath)
  const name = options.applicationName ?? discovered?.name ?? options.service ?? 'unknown-application'
  const version = options.applicationVersion ?? discovered?.version ?? options.release ?? '0.0.0-unknown'
  return Object.freeze({ name, version, ...(discovered?.path ? { packageJsonPath: discovered.path } : {}) })
}

function readPackage(explicitPath?: string): { name?: string; version?: string; path: string } | null {
  if (explicitPath) return parsePackage(isAbsolute(explicitPath) ? explicitPath : resolve(process.cwd(), explicitPath))

  let directory = process.cwd()
  while (true) {
    const candidate = join(directory, 'package.json')
    const parsed = parsePackage(candidate)
    if (parsed) return parsed
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function parsePackage(path: string): { name?: string; version?: string; path: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const name = typeof value['name'] === 'string' && value['name'].trim() ? value['name'].trim() : undefined
    const version = typeof value['version'] === 'string' && value['version'].trim() ? value['version'].trim() : undefined
    if (!name && !version) return null
    return { ...(name ? { name } : {}), ...(version ? { version } : {}), path }
  } catch {
    return null
  }
}
