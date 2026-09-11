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
import type { PrivacyCaptureConfig } from '../types/config.js'

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

  return new OTelMongoDBInstrumentation(instrumentationOptions)
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
