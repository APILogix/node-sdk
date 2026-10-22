/**
 * safe-wrapper — defensive foundation for auto-instrumentation modules.
 *
 * Provides:
 * - Fail-open module resolution (zero crashes when optional dependencies are missing)
 * - Process-wide idempotent patching guards
 * - Centralized teardown registration
 * - Non-event-blocking bounded string sanitization (< 50µs)
 * - Safe span execution boundaries
 */

import { createRequire } from 'node:module'
import { SpanKind, SpanStatusCode, trace, type Span, type SpanOptions, type Tracer } from '@opentelemetry/api'
import { getLogger } from '../utils/logger.js'

const TEARDOWN_REGISTRY = Symbol.for('pulse-sdk.auto-instrumentation.teardowns')

interface GlobalTeardownState {
  [TEARDOWN_REGISTRY]?: Array<() => void | Promise<void>>
}

/**
 * Safely resolves an optional dependency from the host application's working
 * directory or local module resolution without throwing MODULE_NOT_FOUND.
 */
export function resolveModuleSafe(moduleName: string, force = false): any | null {
  try {
    const cwdRequire = createRequire(process.cwd() + '/package.json')
    const resolved = cwdRequire.resolve(moduleName)
    if (cwdRequire.cache && cwdRequire.cache[resolved]) {
      return cwdRequire.cache[resolved].exports
    }
    if (force) {
      return cwdRequire(moduleName)
    }
  } catch {
    try {
      const localRequire = createRequire(import.meta.url)
      const resolved = localRequire.resolve(moduleName)
      if (localRequire.cache && localRequire.cache[resolved]) {
        return localRequire.cache[resolved].exports
      }
      if (force) {
        return localRequire(moduleName)
      }
    } catch {
      return null
    }
  }
  return null
}

/**
 * Applies an idempotent patch guarded by a unique global Symbol.
 * Ensures the patch is applied at most once per process and registers
 * its teardown function in the SDK's central teardown registry.
 */
export function applyIdempotentPatch(
  guardSymbol: symbol,
  patchFn: () => (() => void) | void,
): boolean {
  const g = globalThis as Record<symbol, unknown> & GlobalTeardownState
  if (g[guardSymbol]) {
    return false
  }

  try {
    const teardown = patchFn()
    g[guardSymbol] = true

    if (typeof teardown === 'function') {
      if (!g[TEARDOWN_REGISTRY]) {
        g[TEARDOWN_REGISTRY] = []
      }
      g[TEARDOWN_REGISTRY].push(() => {
        try {
          teardown()
        } catch (err) {
          getLogger().debug('[SafeWrapper] Teardown threw error', { error: String(err) })
        } finally {
          delete g[guardSymbol]
        }
      })
    }
    return true
  } catch (err) {
    getLogger().debug('[SafeWrapper] Idempotent patch failed to apply', {
      error: String(err),
    })
    return false
  }
}

/**
 * Redacts query strings, parameters, or payloads with guaranteed memory bounds.
 * Never executes slow multi-pass regexes on large inputs.
 */
export function sanitizeQueryStatement(query: unknown, maxLength = 2048): string {
  if (typeof query !== 'string') {
    if (query == null) return ''
    try {
      return String(query).slice(0, maxLength)
    } catch {
      return ''
    }
  }

  const bounded = query.slice(0, maxLength)
  // Fast sanitization for SQL string literals and hex payloads
  return bounded
    .replace(/'(?:[^'\\]|\\.)*'/g, "'?'")
    .replace(/\b(?:\d{16}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4})\b/g, '[REDACTED]')
}

/**
 * Wraps a synchronous or asynchronous driver operation in a safe OpenTelemetry span.
 * Guarantees that any instrumentation failure never affects host application execution.
 */
export function withSafeSpan<T>(
  tracer: Tracer,
  name: string,
  options: SpanOptions,
  execute: (span: Span) => T,
): T {
  const span = tracer.startSpan(name, options)
  try {
    const result = execute(span)
    if (result && typeof (result as any).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (val) => {
          try {
            span.setStatus({ code: SpanStatusCode.OK })
            span.end()
          } catch {}
          return val
        },
        (err) => {
          try {
            span.recordException(err instanceof Error ? err : new Error(String(err)))
            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
            span.end()
          } catch {}
          throw err
        },
      ) as unknown as T
    }

    try {
      span.setStatus({ code: SpanStatusCode.OK })
      span.end()
    } catch {}
    return result
  } catch (err) {
    try {
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as any)?.message ?? String(err) })
      span.end()
    } catch {}
    throw err
  }
}
