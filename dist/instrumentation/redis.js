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
import crypto from 'node:crypto';
import { RedisInstrumentation as OTelRedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { IORedisInstrumentation as OTelIORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
const SENSITIVE_KEY_PATTERNS = [
    /auth/i,
    /passw/i,
    /secret/i,
    /token/i,
    /(?:^|[_:.-])(?:api[-_]?key|private[-_]?key|secret[-_]?key|access[-_]?key)(?:$|[_:.-])/i,
    /jwt/i,
    /bearer/i,
    /session/i,
    /cred/i,
];
const READ_COMMANDS = new Set([
    'GET', 'MGET', 'HGET', 'HMGET', 'HGETALL', 'HEXISTS', 'HLEN', 'HKEYS',
    'EXISTS', 'TTL', 'PTTL', 'TYPE', 'STRLEN', 'LLEN', 'LRANGE', 'LINDEX',
    'SCARD', 'SMEMBERS', 'SISMEMBER', 'ZCARD', 'ZRANGE', 'ZRANGEBYSCORE', 'ZSCORE', 'ZRANK',
    'PFCOUNT', 'XREAD', 'XRANGE', 'GEOPOS', 'GETRANGE',
]);
export function isSensitiveRedisKey(key) {
    const boundedKey = typeof key === 'string' ? key.slice(0, 256) : String(key ?? '').slice(0, 256);
    return SENSITIVE_KEY_PATTERNS.some(pat => pat.test(boundedKey));
}
export function createRedisStatementSerializer(keyPolicy = 'sanitized-key', captureBody = true) {
    return (cmdName, cmdArgs) => {
        const upperCmd = typeof cmdName === 'string' ? cmdName.toUpperCase() : String(cmdName);
        // Security invariant: AUTH, CONFIG SET/GET must NEVER expose passwords or configs
        if (upperCmd === 'AUTH') {
            return 'AUTH [REDACTED]';
        }
        if (upperCmd.startsWith('CONFIG SET') || (upperCmd === 'CONFIG' && String(cmdArgs?.[0]).toUpperCase() === 'SET')) {
            return 'CONFIG SET [REDACTED]';
        }
        if (keyPolicy === 'command-only' || !captureBody) {
            return cmdName;
        }
        if (!Array.isArray(cmdArgs) || cmdArgs.length === 0) {
            return cmdName;
        }
        const rawKey = String(cmdArgs[0] ?? '').slice(0, 256);
        let formattedKey = rawKey;
        if (keyPolicy === 'hash') {
            const hash = crypto.createHash('sha256').update(rawKey).digest('hex').substring(0, 12);
            formattedKey = `hash:${hash}`;
        }
        else if (keyPolicy === 'sanitized-key') {
            if (isSensitiveRedisKey(rawKey)) {
                formattedKey = '[REDACTED_KEY]';
            }
        }
        else if (keyPolicy === 'full') {
            if (isSensitiveRedisKey(rawKey)) {
                formattedKey = '[REDACTED_KEY]';
            }
        }
        // Read commands: key is visible according to policy
        if (READ_COMMANDS.has(upperCmd)) {
            return `${cmdName} ${formattedKey}`;
        }
        // Write commands: key is formatted, arguments/values are safely redacted
        return `${cmdName} ${formattedKey} [REDACTED]`;
    };
}
export function createRedisInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const keyPolicy = mergedOptions?.keyPolicy ?? 'sanitized-key';
    const instrumentationOptions = {
        enabled: true,
        ...(mergedOptions?.requireParentSpan !== undefined ? { requireParentSpan: mergedOptions.requireParentSpan } : {}),
        dbStatementSerializer: mergedOptions?.dbStatementSerializer ?? createRedisStatementSerializer(keyPolicy, captureBody),
    };
    if (mergedOptions?.addResponseHook) {
        instrumentationOptions.responseHook = mergedOptions.addResponseHook;
    }
    return new OTelRedisInstrumentation(instrumentationOptions);
}
export function createIORedisInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const keyPolicy = mergedOptions?.keyPolicy ?? 'sanitized-key';
    return new OTelIORedisInstrumentation({
        ...(mergedOptions?.requireParentSpan !== undefined ? { requireParentSpan: mergedOptions.requireParentSpan } : {}),
        dbStatementSerializer: mergedOptions?.dbStatementSerializer ?? createRedisStatementSerializer(keyPolicy, captureBody),
    });
}
export { OTelRedisInstrumentation, OTelIORedisInstrumentation };
export default createRedisInstrumentation;
