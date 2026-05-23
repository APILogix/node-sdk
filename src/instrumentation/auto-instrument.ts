/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards, now driven by remote config.
 *
 * Reads from ConfigManager.getConfig().instrumentation to decide
 * which modules to patch. Never monkey-patches a module if its
 * remote config flag is false.
 *
 * Provides:
 * - HTTP client instrumentation (http/https/fetch/undici)
 * - Express framework instrumentation
 * - Fastify framework instrumentation (with captureHooks / captureValidationErrors)
 * - Self-request guard (prevents tracing SDK's own ingestion calls)
 * - No duplicate spans (OTel SDK handles deduplication)
 * - Low-overhead runtime performance
 *
 * Architecture:
 *   OTel Instrumentation → Pulse SpanProcessor → PipelineSpanExporter → EventPipeline
 */

import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { client } from '../core/client.js'
import { getLogger } from '../utils/logger.js'
import { ConfigManager } from '../core/config-manager.js'
import type { InstrumentationConfig, TracingRemoteConfig } from '../types/config.js'

// ─── State ──────────────────────────────────────────────────────────────────

const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered')

// ─── Auto Instrumentation ───────────────────────────────────────────────────

export interface AutoInstrumentOptions {
  /** Enable HTTP client auto-instrumentation. Default: true */
  http?: boolean
  /** Enable Express auto-instrumentation. Default: true */
  express?: boolean
  /** Enable Fastify auto-instrumentation. Default: true */
  fastify?: boolean
  /** Enable Undici/fetch auto-instrumentation. Default: true */
  undici?: boolean
}

/**
 * Resolve instrumentation options from remote config.
 * Remote config takes priority, user options only serve as fallback.
 */
function resolveInstrumentationOptions(userOptions: AutoInstrumentOptions): {
  http: boolean
  express: boolean
  fastify: boolean
  undici: boolean
  fastifyConfig: { captureHooks: boolean; captureValidationErrors: boolean }
  ignoredRoutes: string[]
  ignoredMethods: string[]
} {
  const configManager = ConfigManager.getInstance()
  const config = configManager.getConfig()
  const instr: InstrumentationConfig = config.instrumentation
  const tracing: TracingRemoteConfig = config.tracing

  // Resolve each integration from remote config. Object-form integrations
  // have an `enabled` field; boolean-form is the flag itself.
  const httpEnabled = instr.http ?? userOptions.http ?? true
  const httpsEnabled = instr.https ?? true

  // Express: object with `enabled` or boolean
  const expressEnabled = typeof instr.express === 'object'
    ? instr.express.enabled
    : (instr.express ?? userOptions.express ?? true)

  // Fastify: object with `enabled`, `captureHooks`, `captureValidationErrors`
  const fastifyConfig = typeof instr.fastify === 'object'
    ? instr.fastify
    : { enabled: instr.fastify ?? userOptions.fastify ?? true, captureHooks: true, captureValidationErrors: true }

  // Undici/fetch
  const fetchEnabled = instr.fetch ?? userOptions.undici ?? true

  return {
    http: httpEnabled && httpsEnabled,
    express: expressEnabled,
    fastify: fastifyConfig.enabled,
    undici: fetchEnabled,
    fastifyConfig: {
      captureHooks: fastifyConfig.captureHooks ?? true,
      captureValidationErrors: fastifyConfig.captureValidationErrors ?? true,
    },
    ignoredRoutes: [...(tracing.ignoredRoutes ?? [])],
    ignoredMethods: [...(tracing.ignoredMethods ?? [])],
  }
}

/**
 * Register OpenTelemetry auto-instrumentations with Pulse SDK guards.
 * Reads from remote config to decide which integrations to enable.
 *
 * Idempotent — safe to call multiple times, even across multiple SDK copies
 * in the same V8 isolate (uses Symbol.for global guard).
 */
export function registerAutoInstrumentations(options: AutoInstrumentOptions = {}): void {
  const g = globalThis as typeof globalThis & { [INSTRUMENTATION_GUARD]?: boolean }
  if (g[INSTRUMENTATION_GUARD]) return
  g[INSTRUMENTATION_GUARD] = true

  const logger = getLogger()
  const resolved = resolveInstrumentationOptions(options)
  const instrumentations: unknown[] = []

  if (resolved.http) {
    instrumentations.push(
      new HttpInstrumentation({
        ignoreOutgoingRequestHook: (request: unknown) => {
          if (!client.initialized) return false
          try {
            const ingestUrl = client.config.ingestUrl
            if (!ingestUrl) return false

            let url = ''
            if (typeof request === 'string') {
              url = request
            } else if (request && typeof request === 'object') {
              const req = request as Record<string, unknown>
              url = String(req.href ?? req.url ?? '')
            }
            if (!url) return false

            const target = new URL(url)
            const ingest = new URL(ingestUrl)
            return isInternalSdkUrl(target, ingest)
          } catch {
            return false
          }
        },
        ignoreIncomingRequestHook: (request: unknown) => {
          try {
            const req = request as Record<string, unknown>
            const url = String(req.url ?? '')
            const path = url.split('?')[0] ?? ''

            // Check tracing.ignoredRoutes from remote config
            if (resolved.ignoredRoutes.some(r => path === r || path.startsWith(r))) {
              return true
            }

            // Check tracing.ignoredMethods from remote config
            const method = String(req.method ?? '').toUpperCase()
            if (resolved.ignoredMethods.includes(method)) {
              return true
            }

            // Always ignore SDK internal routes
            return ['/v1/events', '/v1/init', '/v1/sdk-config'].includes(path)
          } catch {
            return false
          }
        },
      })
    )
  }

  if (resolved.express) {
    instrumentations.push(
      new ExpressInstrumentation()
    )
  }

  if (resolved.fastify) {
    instrumentations.push(
      new FastifyInstrumentation()
    )
  }

  if (resolved.undici) {
    instrumentations.push(
      new UndiciInstrumentation({
        ignoreRequestHook: (request: unknown) => {
          if (!client.initialized) return false
          try {
            const ingest = new URL(client.config.ingestUrl)
            const req = request as Record<string, unknown>
            const rawOrigin = req.origin ?? req['origin']
            const rawPath = req.path ?? req['path'] ?? req.pathname
            const url = rawOrigin
              ? new URL(String(rawPath ?? '/'), String(rawOrigin))
              : new URL(String(req.url ?? ''))
            return isInternalSdkUrl(url, ingest)
          } catch {
            return false
          }
        },
      })
    )
  }

  if (instrumentations.length === 0) {
    logger.debug('No auto-instrumentations registered (all disabled by remote config)')
    return
  }

  registerInstrumentations({
    instrumentations: instrumentations as any[],
  })

  logger.info('Auto-instrumentations registered (remote-config-driven)', {
    http: resolved.http,
    express: resolved.express,
    fastify: resolved.fastify,
    undici: resolved.undici,
    ignoredRoutes: resolved.ignoredRoutes,
    ignoredMethods: resolved.ignoredMethods,
    count: instrumentations.length,
  })
}

/**
 * Reset auto-instrumentation state — for testing.
 * @internal
 */
export function resetAutoInstrumentations(): void {
  delete (globalThis as typeof globalThis & { [INSTRUMENTATION_GUARD]?: boolean })[INSTRUMENTATION_GUARD]
}

function isInternalSdkUrl(target: URL, ingest: URL): boolean {
  if (target.origin !== ingest.origin) return false
  return target.pathname === ingest.pathname
    || target.pathname === '/v1/events'
    || target.pathname === '/v1/init'
    || target.pathname === '/v1/sdk-config'
}
