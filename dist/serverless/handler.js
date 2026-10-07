import { flush } from '../core/lifecycle.js';
import { captureException } from '../capture/captureException.js';
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
 * 2. Catches unhandled errors, captures them with `captureException`, flushes within deadline, and rethrows.
 * 3. On successful return, flushes pending traces, metrics, and logs synchronously before execution freeze.
 */
export function wrapHandler(handler, options = {}) {
    const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    const captureErrors = options.captureErrors ?? true;
    const setCallbackWaits = options.callbackWaitsForEmptyEventLoop ?? true;
    return async (event, context, callback) => {
        if (setCallbackWaits && context && typeof context === 'object') {
            try {
                ;
                context.callbackWaitsForEmptyEventLoop = false;
            }
            catch {
                // Ignore if context is frozen or property cannot be set
            }
        }
        try {
            const result = await Promise.resolve(handler(event, context, callback));
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
    };
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
