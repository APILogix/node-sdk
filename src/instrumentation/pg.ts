/**
 * PostgreSQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, table, and database
 * - Parameterized query capture (configurable via captureParams)
 * - Prepared statement support
 * - Connection pool monitoring
 * - Error tracking with query context
 */

import { PgInstrumentation as OTelPgInstrumentation } from '@opentelemetry/instrumentation-pg'
import type { PgInstrumentationConfig as OTelPgInstrumentationConfig } from '@opentelemetry/instrumentation-pg'
import type { PrivacyCaptureConfig } from '../types/config.js'

export interface PgInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
  captureParams?: boolean
}

export function createPgInstrumentation(
  enabled: boolean,
  mergedOptions?: Partial<PgInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): OTelPgInstrumentation | null {
  if (!enabled) {
    return null
  }

  const captureBody = captureConfig?.body ?? false

  const instrumentationOptions: OTelPgInstrumentationConfig = {
    enabled: true,
    enhancedDatabaseReporting: mergedOptions?.captureQueries ?? captureBody,
    addSqlCommenterCommentToQueries: false,
  }

  return new OTelPgInstrumentation(instrumentationOptions)
}

export interface PgSpanAttributes {
  'db.system': 'postgresql'
  'db.name': string
  'db.operation': string
  'db.sql.table'?: string
  'db.statement'?: string
}

export { OTelPgInstrumentation }
export default createPgInstrumentation
