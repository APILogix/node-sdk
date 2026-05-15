/**
 * Universal event capture — the single entry point for all SDK event ingestion.
 *
 * All other capture functions (captureError, captureRequest, captureMessage, captureMetric)
 * delegate to this function, which routes events through the processing pipeline.
 */
import { processEvent } from '../core/event-pipeline.js';
import { getLogger } from '../utils/logger.js';
/**
 * Capture an event and route it through the full processing pipeline.
 *
 * @param event - Any SDK event (error, request, message, metric, or custom)
 * @returns true if the event was accepted into the queue, false if dropped
 */
export function captureEvent(event) {
    const logger = getLogger();
    try {
        return processEvent(event);
    }
    catch (error) {
        // captureEvent must NEVER throw — it must be safe to call anywhere
        logger.error('captureEvent failed unexpectedly', { error });
        return false;
    }
}
//# sourceMappingURL=captureEvent.js.map