/**
 * Redis Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Command spans with operation, key, and database
 * - Pipeline/batch command aggregation
 * - Connection tracking
 * - Error tracking with command context
 * - Stream operations support (XADD, XRANGE, etc.)
 */

import { RedisInstrumentation as OTelRedisInstrumentation } from '@opentelemetry/instrumentation-redis'
import type {
  DbStatementSerializer,
  RedisInstrumentationConfig as OTelRedisInstrumentationConfig,
  RedisResponseCustomAttributeFunction,
} from '@opentelemetry/instrumentation-redis'
import type { PrivacyCaptureConfig } from '../types/config.js'

export interface RedisInstrumentationOptions {
  enabled: boolean
  dbStatementSerializer?: DbStatementSerializer
  addResponseHook?: RedisResponseCustomAttributeFunction
}

export function createRedisInstrumentation(
  enabled: boolean,
  mergedOptions?: Partial<RedisInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): OTelRedisInstrumentation | null {
  if (!enabled) {
    return null
  }

  const captureBody = captureConfig?.body ?? false

  const instrumentationOptions: OTelRedisInstrumentationConfig = {
    enabled: true,
    dbStatementSerializer: mergedOptions?.dbStatementSerializer ?? ((cmdName, cmdArgs) => {
      if (!captureBody) {
        return cmdName
      }
      const sensitiveCommands = ['AUTH', 'CONFIG SET', 'CONFIG GET', 'DEL', 'EXPIRE', 'EXPIREAT', 'GET', 'SET', 'HSET', 'HGET', 'HGETALL']
      if (sensitiveCommands.includes(cmdName.toUpperCase())) {
        return `${cmdName} [REDACTED]`
      }
      return `${cmdName} ${cmdArgs.join(' ')}`
    }),
  }

  if (mergedOptions?.addResponseHook) {
    instrumentationOptions.responseHook = mergedOptions.addResponseHook
  }

  return new OTelRedisInstrumentation(instrumentationOptions)
}

export interface RedisSpanAttributes {
  'db.system': 'redis'
  'db.redis.command': string
  'db.redis.command_args': string
  'db.redis.key'?: string
  'db.redis.database': number
}

export { OTelRedisInstrumentation }
export default createRedisInstrumentation
