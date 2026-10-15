import { flush } from '../core/lifecycle.js';
import { captureException } from '../capture/captureException.js';
import { createContextStore, withContext } from '../core/context.js';
import { generateId } from '../utils/uuid.js';
import { getLogger } from '../utils/logger.js';
const DEFAULT_FLUSH_TIMEOUT_MS = 1500;
/**
 * Wrap an AWS Lambda or serverless function handler to guarantee telemetry delivery.
 *
 * In serverless environments, background timers cannot flush events after the handler returns
 * because the hypervisor immediately freezes CPU execution.
 *
 * `wrapHandler`:
 * 1. Sets `context.callbackWaitsForEmptyEventLoop = false` (AWS Lambda best practice).
 * 2. Isolates execution in a fresh ContextStore to prevent cross-invocation context bleed.
 * 3. Handles both async/Promise handlers and callback-style handlers (handler.length >= 3).
 * 4. Catches unhandled errors, captures them with `captureException`, flushes within deadline, and rethrows.
 * 5. On successful return, flushes pending traces, metrics, and logs synchronously before execution freeze.
 */
export function wrapHandler(handler, options = {}) {
    const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    const captureErrors = options.captureErrors ?? true;
    const setCallbackWaits = options.callbackWaitsForEmptyEventLoop ?? true;
    return async (event, context, callback) => {
        let requestId = generateId();
        if (context && typeof context === 'object') {
            const ctxObj = context;
            if (typeof ctxObj['awsRequestId'] === 'string' && ctxObj['awsRequestId']) {
                requestId = ctxObj['awsRequestId'];
            }
            if (setCallbackWaits) {
                try {
                    ctxObj.callbackWaitsForEmptyEventLoop = false;
                }
                catch { }
            }
        }
        const store = createContextStore(requestId, 100, {
            tags: { runtime: 'serverless' },
        });
        return withContext(store, async () => {
            try {
                const result = await executeHandler(handler, event, context, callback);
                await flushSafely(flushTimeoutMs);
                return result;
            }
            catch (error) {
                if (captureErrors) {
                    try {
                        captureException(error instanceof Error ? error : new Error(String(error)));
                    }
                    catch (captureErr) {
                        getLogger().debug('Failed to capture serverless handler exception', { error: captureErr });
                    }
                }
                await flushSafely(flushTimeoutMs);
                throw error;
            }
        });
    };
}
function executeHandler(handler, event, context, callback) {
    if (handler.length >= 3) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const cb = (err, res) => {
                if (settled)
                    return;
                settled = true;
                if (typeof callback === 'function') {
                    try {
                        callback(err, res);
                    }
                    catch { }
                }
                if (err)
                    reject(err);
                else
                    resolve(res);
            };
            try {
                const maybePromise = handler(event, context, cb);
                if (maybePromise && typeof maybePromise.then === 'function') {
                    ;
                    maybePromise.then(res => {
                        if (!settled) {
                            settled = true;
                            resolve(res);
                        }
                    }, err => {
                        if (!settled) {
                            settled = true;
                            reject(err);
                        }
                    });
                }
            }
            catch (syncErr) {
                if (!settled) {
                    settled = true;
                    reject(syncErr);
                }
            }
        });
    }
    return Promise.resolve(handler(event, context, callback));
}
async function flushSafely(timeoutMs) {
    let timer;
    try {
        const timeoutPromise = new Promise(resolve => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
        });
        await Promise.race([flush(), timeoutPromise]);
    }
    catch (error) {
        getLogger().debug('Serverless flush timed out or failed', { error });
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
