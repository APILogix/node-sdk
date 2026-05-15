/**
 * Error capture — captures exceptions and routes them through the event pipeline.
 *
 * Features:
 * - Pre-init buffering (events captured before SDK is ready are queued)
 * - Automatic breadcrumb attachment from async context
 * - Stack frame parsing and fingerprinting
 * - Severity classification
 * - Plugin processing via event pipeline
 */
import { toError } from '../core/errors.js';
import { getLogger } from '../utils/logger.js';
import { parseStack } from '../processors/stack-parser.js';
import { generateFingerprint } from '../processors/fingerprint.js';
import { getRequestContext } from '../core/context.js';
import { captureEvent } from './captureEvent.js';
import { Severity } from '../types/severity.js';
import { epochMs } from '../utils/time.js';
/**
 * Capture an error/exception.
 *
 * @param error - The error to capture (Error, string, or unknown)
 * @param options - Optional severity, context, and fingerprint overrides
 */
export function captureError(error, options = {}) {
    const logger = getLogger();
    try {
        const normalized = toError(error);
        // Support both old API (context object) and new API (CaptureErrorOptions)
        const context = isOptionsObject(options)
            ? (options.context ?? {})
            : options;
        const severity = isOptionsObject(options)
            ? (options.severity ?? Severity.Error)
            : Severity.Error;
        const customFingerprint = isOptionsObject(options)
            ? options.fingerprint
            : undefined;
        const stackFrames = parseStack(normalized.stack);
        const fingerprint = generateFingerprint(normalized, stackFrames, customFingerprint);
        // Get breadcrumbs from async context
        const ctx = getRequestContext();
        const breadcrumbs = ctx?.breadcrumbs.toArray() ?? [];
        const event = {
            type: 'error',
            message: normalized.message,
            name: normalized.name,
            stack: stackFrames,
            fingerprint,
            severity,
            timestamp: epochMs(),
            context,
            breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            requestId: ctx?.requestId,
            traceId: ctx?.traceId,
            spanId: ctx?.spanId,
        };
        captureEvent(event);
    }
    catch (err) {
        logger.error('captureError failed', { error: err });
    }
}
function isOptionsObject(value) {
    if (!value || typeof value !== 'object')
        return false;
    return 'severity' in value || 'fingerprint' in value || 'context' in value;
}
//# sourceMappingURL=captureError.js.map