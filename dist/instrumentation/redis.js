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
import { RedisInstrumentation as OTelRedisInstrumentation } from '@opentelemetry/instrumentation-redis';
export function createRedisInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const instrumentationOptions = {
        enabled: true,
        dbStatementSerializer: mergedOptions?.dbStatementSerializer ?? ((cmdName, cmdArgs) => {
            if (!captureBody) {
                return cmdName;
            }
            const sensitiveCommands = ['AUTH', 'CONFIG SET', 'CONFIG GET', 'DEL', 'EXPIRE', 'EXPIREAT', 'GET', 'SET', 'HSET', 'HGET', 'HGETALL'];
            if (sensitiveCommands.includes(cmdName.toUpperCase())) {
                return `${cmdName} [REDACTED]`;
            }
            return `${cmdName} ${cmdArgs.join(' ')}`;
        }),
    };
    if (mergedOptions?.addResponseHook) {
        instrumentationOptions.responseHook = mergedOptions.addResponseHook;
    }
    return new OTelRedisInstrumentation(instrumentationOptions);
}
export { OTelRedisInstrumentation };
export default createRedisInstrumentation;
