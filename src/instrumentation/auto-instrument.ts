/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards to prevent duplicate spans and
 * recursive SDK tracing.
 *
 * Provides:
 * - HTTP client instrumentation (http/https/fetch/undici)
 * - Express framework instrumentation
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
import { client } from '../core/client.js'
import { getLogger } from '../utils/logger.js'

// ─── State ──────────────────────────────────────────────────────────────────

let instrumented = false

// ─── Auto Instrumentation ───────────────────────────────────────────────────

export interface AutoInstrumentOptions {
  /** Enable HTTP client auto-instrumentation. Default: true */
  http?: boolean
  /** Enable Express auto-instrumentation. Default: true */
  express?: boolean
}

/**
 * Register OpenTelemetry auto-instrumentations with Pulse SDK guards.
 * Idempotent — safe to call multiple times.
 */
export function registerAutoInstrumentations(options: AutoInstrumentOptions = {}): void {
  if (instrumented) return
  instrumented = true

  const logger = getLogger()
  const instrumentations: unknown[] = []

  if (options.http !== false) {
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
            return target.origin === ingest.origin && target.pathname === ingest.pathname
          } catch {
            return false
          }
        },
        ignoreIncomingRequestHook: (request: unknown) => {
          try {
            const req = request as Record<string, unknown>
            const url = String(req.url ?? '')
            const path = url.split('?')[0] ?? ''
            return ['/health', '/ready', '/healthz', '/livez', '/metrics'].includes(path)
          } catch {
            return false
          }
        },
      })
    )
  }

  if (options.express !== false) {
    instrumentations.push(
      new ExpressInstrumentation()
    )
  }

  if (instrumentations.length === 0) {
    logger.debug('No auto-instrumentations registered')
    return
  }

  registerInstrumentations({
    instrumentations: instrumentations as any[],
  })

  logger.info('Auto-instrumentations registered', {
    http: options.http !== false,
    express: options.express !== false,
    count: instrumentations.length,
  })
}

/**
 * Reset auto-instrumentation state — for testing.
 * @internal
 */
export function resetAutoInstrumentations(): void {
  instrumented = false
}
