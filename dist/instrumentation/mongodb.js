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
import { MongoDBInstrumentation as OTelMongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { context, createContextKey, trace } from '@opentelemetry/api';
import { safeJsonStringify } from '../utils/safe-json.js';
export const SUPPRESS_MONGODB_DRIVER_SPANS = createContextKey('lynktrace.mongodb.suppress-driver-spans');
export const SUPPRESS_MONGODB_DRIVER_SPANS_LEGACY = createContextKey('pulse-sdk.mongodb.suppress-driver-spans');
export function createMongoDBInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const instrumentationOptions = {
        enabled: true,
        enhancedDatabaseReporting: mergedOptions?.enhancedDatabaseReporting ?? false,
        requireParentSpan: mergedOptions?.requireParentSpan ?? false,
        dbStatementSerializer: mergedOptions?.dbStatementSerializer ?? ((command) => {
            if (!captureBody) {
                return '[REDACTED]';
            }
            try {
                const safeCmd = {};
                for (const [k, v] of Object.entries(command)) {
                    if (k === 'documents' || k === 'updates' || k === 'deletes' || k === 'lsid' || k === '$clusterTime') {
                        safeCmd[k] = Array.isArray(v) ? `[Array(${v.length})]` : '[OMITTED]';
                    }
                    else {
                        safeCmd[k] = v;
                    }
                }
                const str = JSON.stringify(safeCmd);
                return str.length > 2048 ? `${str.slice(0, 2048)}...[truncated]` : str;
            }
            catch {
                return '[UNSERIALIZABLE]';
            }
        }),
    };
    const instrumentation = new OTelMongoDBInstrumentation(instrumentationOptions);
    const originalSkipCheck = instrumentation._checkSkipInstrumentation;
    if (typeof originalSkipCheck === 'function') {
        ;
        instrumentation._checkSkipInstrumentation = function lynktraceCheckSkipMongoDBInstrumentation(currentSpan) {
            if (context.active().getValue(SUPPRESS_MONGODB_DRIVER_SPANS) === true ||
                context.active().getValue(SUPPRESS_MONGODB_DRIVER_SPANS_LEGACY) === true) {
                return true;
            }
            return originalSkipCheck.call(this, currentSpan);
        };
    }
    // Filter out standalone root traces for startup indexing commands (e.g. createIndexes, create, listIndexes)
    // when executed without an active parent span, preventing thousands of 1-span startup traces from flooding APM.
    const origV4Promise = instrumentation._getV4PatchCommandPromise;
    if (typeof origV4Promise === 'function') {
        ;
        instrumentation._getV4PatchCommandPromise = function lynktraceGetV4PatchCommandPromise(...promiseArgs) {
            const patcher = origV4Promise.apply(this, promiseArgs);
            return function (original) {
                const patched = patcher(original);
                return function patchedV4ServerCommand(...args) {
                    const [, cmd] = args;
                    const currentSpan = trace.getSpan(context.active());
                    if (!currentSpan && cmd && typeof cmd === 'object' && (cmd.createIndexes || cmd.create || cmd.listIndexes || cmd.buildInfo)) {
                        return original.apply(this, args);
                    }
                    return patched.apply(this, args);
                };
            };
        };
    }
    const origV4Callback = instrumentation._getV4PatchCommandCallback;
    if (typeof origV4Callback === 'function') {
        ;
        instrumentation._getV4PatchCommandCallback = function lynktraceGetV4PatchCommandCallback(...callbackArgs) {
            const patcher = origV4Callback.apply(this, callbackArgs);
            return function (original) {
                const patched = patcher(original);
                return function patchedV4ServerCommand(ns, cmd, options, callback) {
                    const currentSpan = trace.getSpan(context.active());
                    if (!currentSpan && cmd && typeof cmd === 'object' && (cmd.createIndexes || cmd.create || cmd.listIndexes || cmd.buildInfo)) {
                        return original.call(this, ns, cmd, options, callback);
                    }
                    return patched.call(this, ns, cmd, options, callback);
                };
            };
        };
    }
    return instrumentation;
}
export { OTelMongoDBInstrumentation };
export default createMongoDBInstrumentation;
