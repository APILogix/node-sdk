/**
 * ESM Loader Hooks � Registers module interception hooks with Node.js
 * to enable OpenTelemetry instrumentation for native ECMAScript Modules (ESM).
 *
 * Architecture:
 * 1. Synchronous in-thread loader hooks via module.registerHooks()
 *    (Node >= 22.22.3, >= 24.11.1, >= 25.1.0, >= 26.0.0).
 *    Runs in the main thread with zero IPC overhead.
 * 2. Asynchronous thread-based hooks via module.register()
 *    (Node >= 18.19.0, >= 20.6.0) as fallback.
 * 3. Preload hook via node --import @lynktrace/node/register.
 *
 * Guarantees:
 * - Idempotent registration via global Symbol guard.
 * - Safe fail-open behavior: never throws or crashes runtime.
 */

import * as nodeModule from 'node:module'
// @ts-expect-error - import-in-the-middle does not ship TypeScript declaration for register-hooks.mjs
import { register as registerSyncHooks, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs'
import { getLogger } from '../utils/logger.js'

const ESM_HOOKS_APPLIED = Symbol.for('lynktrace.esm-loader-hooks.applied')
const ESM_HOOKS_APPLIED_LEGACY = Symbol.for('pulse-sdk.esm-loader-hooks.applied')

interface GlobalWithEsmHooks {
  [ESM_HOOKS_APPLIED]?: boolean
  [ESM_HOOKS_APPLIED_LEGACY]?: boolean
}

/**
 * Register Node.js ESM loader hooks for import-in-the-middle.
 *
 * Idempotent: safe to call multiple times across multiple SDK imports.
 * Never throws.
 *
 * @returns true if loader hooks were successfully registered or were already active.
 */
export function registerEsmLoaderHooks(): boolean {
  const g = globalThis as typeof globalThis & GlobalWithEsmHooks
  if (g[ESM_HOOKS_APPLIED] || g[ESM_HOOKS_APPLIED_LEGACY]) {
    return true
  }

  const logger = getLogger()

  try {
    // Strategy 1: Synchronous in-thread hooks (Node 22.22.3+, 24.11.1+, 25.1.0+, 26.0.0+)
    if (typeof supportsSyncHooks === 'function' && supportsSyncHooks()) {
      registerSyncHooks()
      g[ESM_HOOKS_APPLIED] = true
      g[ESM_HOOKS_APPLIED_LEGACY] = true
      logger.debug('Registered synchronous in-thread ESM loader hooks via import-in-the-middle')
      return true
    }

    // Strategy 2: Standard asynchronous module.register (Node 18.19+, 20.6+)
    const registerFn = (nodeModule as any).register
    if (typeof registerFn === 'function') {
      registerFn('import-in-the-middle/hook.mjs', import.meta.url)
      g[ESM_HOOKS_APPLIED] = true
      g[ESM_HOOKS_APPLIED_LEGACY] = true
      logger.debug('Registered asynchronous ESM loader hook via module.register')
      return true
    }

    logger.debug('ESM loader hooks not supported by current Node.js runtime version')
    return false
  } catch (err) {
    // Fail-open: If registration fails (e.g. unsupported flags or restricted worker thread),
    // log a diagnostic message and allow application execution to proceed without crashing.
    logger.debug('Failed to register ESM loader hooks', { error: String(err) })
    return false
  }
}

/**
 * Check whether ESM loader hooks have been registered.
 */
export function isEsmLoaderHookRegistered(): boolean {
  const g = globalThis as typeof globalThis & GlobalWithEsmHooks
  return Boolean(g[ESM_HOOKS_APPLIED] || g[ESM_HOOKS_APPLIED_LEGACY])
}
