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
import { RedisInstrumentation as OTelRedisInstrumentation } from '@opentelemetry/instrumentation-redis-4';
import type { DbStatementSerializer, RedisResponseCustomAttributeFunction } from '@opentelemetry/instrumentation-redis-4';
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface RedisInstrumentationOptions {
    enabled: boolean;
    dbStatementSerializer?: DbStatementSerializer;
    addResponseHook?: RedisResponseCustomAttributeFunction;
}
export declare function createRedisInstrumentation(enabled: boolean, mergedOptions?: Partial<RedisInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): OTelRedisInstrumentation | null;
export interface RedisSpanAttributes {
    'db.system': 'redis';
    'db.redis.command': string;
    'db.redis.command_args': string;
    'db.redis.key'?: string;
    'db.redis.database': number;
}
export { OTelRedisInstrumentation };
export default createRedisInstrumentation;
//# sourceMappingURL=redis.d.ts.map