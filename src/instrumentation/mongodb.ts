/**
 * MongoDB Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Command spans with operation name, collection, database
 * - Request/response size tracking
 * - Sharded cluster support
 * - Replica set awareness
 * - Connection pool monitoring
 */

import { MongoDBInstrumentation as OTelMongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb'
import type { MongoDBInstrumentationConfig as OTelMongoDBInstrumentationConfig } from '@opentelemetry/instrumentation-mongodb'
import { context, createContextKey } from '@opentelemetry/api'
import type { PrivacyCaptureConfig } from '../types/config.js'

export const SUPPRESS_MONGODB_DRIVER_SPANS = createContextKey('pulse-sdk.mongodb.suppress-driver-spans')

export interface MongoDBInstrumentationOptions {
  enabled: boolean
  enhancedDatabaseReporting?: boolean
  dbStatementSerializer?: (command: Record<string, unknown>) => string
  addStatementAttribute?: boolean
  captureCommandArguments?: boolean
  requireParentSpan?: boolean
}

export function createMongoDBInstrumentation(
  enabled: boolean,
  mergedOptions?: Partial<MongoDBInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): OTelMongoDBInstrumentation | null {
  if (!enabled) {
    return null
  }

  const captureBody = captureConfig?.body ?? false

  const instrumentationOptions: OTelMongoDBInstrumentationConfig = {
    enabled: true,
    enhancedDatabaseReporting: mergedOptions?.enhancedDatabaseReporting ?? false,
    ...(mergedOptions?.requireParentSpan !== undefined ? { requireParentSpan: mergedOptions.requireParentSpan } : {}),
    requireParentSpan: mergedOptions?.requireParentSpan ?? false,
    dbStatementSerializer: mergedOptions?.dbStatementSerializer ?? ((command) => {
      if (!captureBody) {
        return '[REDACTED]'
      }
      try {
        return JSON.stringify(command)
      } catch {
        return '[UNSERIALIZABLE]'
      }
    }),
  }

  const instrumentation = new OTelMongoDBInstrumentation(instrumentationOptions)
  const originalSkipCheck = (instrumentation as any)._checkSkipInstrumentation
  if (typeof originalSkipCheck === 'function') {
    ;(instrumentation as any)._checkSkipInstrumentation = function pulseCheckSkipMongoDBInstrumentation(currentSpan: unknown) {
      if (context.active().getValue(SUPPRESS_MONGODB_DRIVER_SPANS) === true) {
        return true
      }
      return originalSkipCheck.call(this, currentSpan)
    }
  }

  return instrumentation
}

export interface MongoDBSpanAttributes {
  'db.system': 'mongodb'
  'db.name': string
  'db.mongodb.cluster': string
  'db.operation': string
  'db.collection': string
  'db.statement'?: string
}

export { OTelMongoDBInstrumentation }
export default createMongoDBInstrumentation
