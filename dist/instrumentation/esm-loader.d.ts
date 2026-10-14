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
/**
 * Register Node.js ESM loader hooks for import-in-the-middle.
 *
 * Idempotent: safe to call multiple times across multiple SDK imports.
 * Never throws.
 *
 * @returns true if loader hooks were successfully registered or were already active.
 */
export declare function registerEsmLoaderHooks(): boolean;
/**
 * Check whether ESM loader hooks have been registered.
 */
export declare function isEsmLoaderHookRegistered(): boolean;
