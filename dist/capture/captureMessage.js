/**
 * Message capture — captures arbitrary text messages with severity.
 * Similar to Sentry's captureMessage().
 */
import { Severity } from '../types/severity.js';
import { captureEvent } from './captureEvent.js';
import { getLogger } from '../utils/logger.js';
import { getRequestContext, getSpanId, getTraceId } from '../core/context.js';
import { epochMs } from '../utils/time.js';
/**
 * Capture a text message at the given severity level.
 *
 * @param message - The message text
 * @param severity - Severity level (default: 'info')
 * @param context - Additional context data
 */
export function captureMessage(message, severity = Severity.Info, context) {
    const logger = getLogger();
    try {
        const ctx = getRequestContext();
        const breadcrumbs = ctx?.breadcrumbs.toArray() ?? [];
        const event = {
            type: 'message',
            message,
            severity,
            timestamp: epochMs(),
            context,
            breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            traceId: getTraceId(),
            spanId: getSpanId(),
        };
        captureEvent(event);
    }
    catch (err) {
        logger.error('captureMessage failed', { error: err });
    }
}
//# sourceMappingURL=captureMessage.js.map