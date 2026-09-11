/**
 * Redis & ioredis Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards, configurable key visibility policies,
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
    /key/i,
    /jwt/i,
    /bearer/i,
    /session/i,
    /cred/i,
];
export function isSensitiveRedisKey(key) {
    return SENSITIVE_KEY_PATTERNS.some(pat => pat.test(key));
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
        const rawKey = String(cmdArgs[0] ?? '');
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
        const readCommands = ['GET', 'HGET', 'HGETALL', 'EXISTS', 'TTL', 'PTTL', 'TYPE', 'STRLEN', 'LLEN', 'SCARD', 'ZCARD'];
        if (readCommands.includes(upperCmd)) {
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
