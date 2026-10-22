/**
 * Redis & ioredis Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with LynkTrace SDK guards, configurable key visibility policies,
 * and remote config support.
 *
 * Supported key policies:
 * - 'command-only': only command name is recorded (e.g. GET, SET)
 * - 'sanitized-key': command and sanitized key; sensitive keys and all write values are [REDACTED]
 * - 'hash': command and SHA-256 truncated hash of key
 * - 'full': command and full key (except sensitive credentials/tokens which remain [REDACTED])
 */
import { RedisInstrumentation as OTelRedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { IORedisInstrumentation as OTelIORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import type { DbStatementSerializer, RedisResponseCustomAttributeFunction } from '@opentelemetry/instrumentation-redis';
import type { PrivacyCaptureConfig } from '../types/config.js';
export type RedisKeyVisibilityPolicy = 'command-only' | 'sanitized-key' | 'full' | 'hash';
export interface RedisInstrumentationOptions {
    enabled: boolean;
    keyPolicy?: RedisKeyVisibilityPolicy;
    dbStatementSerializer?: DbStatementSerializer;
    addResponseHook?: RedisResponseCustomAttributeFunction;
    requireParentSpan?: boolean;
}
export declare function isSensitiveRedisKey(key: string): boolean;
export declare function createRedisStatementSerializer(keyPolicy?: RedisKeyVisibilityPolicy, captureBody?: boolean): DbStatementSerializer;
export declare function createRedisInstrumentation(enabled: boolean, mergedOptions?: Partial<RedisInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): OTelRedisInstrumentation | null;
export declare function createIORedisInstrumentation(enabled: boolean, mergedOptions?: Partial<RedisInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): OTelIORedisInstrumentation | null;
export interface RedisSpanAttributes {
    'db.system': 'redis';
    'db.redis.command': string;
    'db.redis.command_args': string;
    'db.redis.key'?: string;
    'db.redis.database': number;
}
export { OTelRedisInstrumentation, OTelIORedisInstrumentation };
export default createRedisInstrumentation;
