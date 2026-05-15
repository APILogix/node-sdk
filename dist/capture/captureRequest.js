/**
 * Request capture — captures HTTP request/response events.
 *
 * Delegates to the central event pipeline for normalization, sanitization,
 * sampling, and plugin processing.
 */
import { captureEvent } from './captureEvent.js';
import { getLogger } from '../utils/logger.js';
/**
 * Capture an HTTP request event.
 * Sampling is handled by the event pipeline — callers don't need to filter.
 */
export function captureRequest(event) {
    const logger = getLogger();
    try {
        captureEvent(event);
    }
    catch (err) {
        logger.error('captureRequest failed', {
            error: err,
            requestId: event.requestId,
            endpoint: event.url,
        });
    }
}
//# sourceMappingURL=captureRequest.js.map