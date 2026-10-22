/**
 * MySQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with LynkTrace SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, table, and database
 * - Prepared statement support
 * - Connection pool monitoring
 * - Error tracking with query context
 * - Transaction instrumentation
 */

import { MySQL2Instrumentation as OTelMySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2'
import type { MySQL2InstrumentationConfig as OTelMySQL2InstrumentationConfig } from '@opentelemetry/instrumentation-mysql2'
import type { PrivacyCaptureConfig } from '../types/config.js'

export interface MySQLInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
}

export function createMySQLInstrumentation(
  enabled: boolean,
  mergedOptions?: Partial<MySQLInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): OTelMySQL2Instrumentation | null {
  if (!enabled) {
    return null
  }

  const captureBody = captureConfig?.body ?? false

  const instrumentationOptions: OTelMySQL2InstrumentationConfig = {
    enabled: true,
    // When captureQueries is false (default), mask query parameters for safety.
    // When captureQueries is true, disable masking to capture full SQL.
    maskStatement: !(mergedOptions?.captureQueries ?? captureBody),
    addSqlCommenterCommentToQueries: false,
  }

  return new OTelMySQL2Instrumentation(instrumentationOptions)
}

export interface MySQLSpanAttributes {
  'db.system': 'mysql'
  'db.name': string
  'db.operation': string
  'db.sql.table'?: string
  'db.statement'?: string
}

export { OTelMySQL2Instrumentation }
export default createMySQLInstrumentation
