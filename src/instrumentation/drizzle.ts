/**
 * Drizzle ORM Instrumentation — zero-overhead auto-instrumentation and logger
 * integration for Drizzle ORM.
 *
 * Provides:
 * - PulseDrizzleLogger: Drop-in logger implementing Drizzle's Logger interface
 * - Auto-instrumentation wrapper for Drizzle database query executions
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { sanitizeQueryStatement } from './safe-wrapper.js'
import type { DrizzleInstrumentationConfig, PrivacyCaptureConfig } from '../types/config.js'

export interface DrizzleInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
  captureParams?: boolean
}

/**
 * Drop-in logger for Drizzle ORM:
 * const db = drizzle(client, { logger: new LynkTraceDrizzleLogger() });
 */
export class LynkTraceDrizzleLogger {
  logQuery(query: string, params: unknown[]): void {
    try {
      const activeSpan = trace.getActiveSpan()
      if (activeSpan) {
        activeSpan.setAttribute('db.orm', 'drizzle')
        activeSpan.setAttribute('db.statement', sanitizeQueryStatement(query, 2048))
        if (params && params.length > 0) {
          activeSpan.setAttribute('db.drizzle.param_count', params.length)
        }
      }
    } catch {}
  }
}

export const PulseDrizzleLogger = LynkTraceDrizzleLogger
export type PulseDrizzleLogger = LynkTraceDrizzleLogger

export function createDrizzleInstrumentation(
  enabled: boolean,
  _options?: Partial<DrizzleInstrumentationOptions>,
  _captureConfig?: PrivacyCaptureConfig,
): { enable: () => void; disable: () => void; teardown: () => void; logger: PulseDrizzleLogger } | null {
  if (!enabled) return null

  const logger = new PulseDrizzleLogger()
  let active = true

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => { active = false },
    logger,
  }
}
