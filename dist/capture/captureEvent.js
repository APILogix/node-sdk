/**
 * Universal event capture — the single entry point for all SDK event ingestion.
 *
 * All other capture functions (captureError, captureRequest, captureMessage, captureMetric)
 * delegate to this function, which routes events through the processing pipeline.
 */
import { enqueueEvent } from '../core/event-pipeline.js';
import { getLogger } from '../utils/logger.js';
/**
 * Capture an event and route it through the full processing pipeline.
 *
 * Returns an `EventReceipt` with clear async acceptance semantics:
 *   - `receipt.accepted` — event was admitted into the pipeline
 *   - `receipt.eventId` — assigned event ID for correlation
 *   - `receipt.reason` — why the event was rejected (if not accepted)
 *   - `receipt.processed` — promise resolving when processing completes
 *
 * @param event - Any SDK event (error, request, message, metric, or custom)
 * @returns EventReceipt with pipeline acceptance status
 *
 * @example
 * ```ts
 * const receipt = captureEvent(event)
 * if (!receipt.accepted) {
 *   console.warn('Event dropped:', receipt.reason)
 * }
 * ```
 */
export function captureEvent(event) {
    const logger = getLogger();
    try {
        return enqueueEvent(event);
    }
    catch (error) {
        // captureEvent must NEVER throw — it must be safe to call anywhere
        logger.error('captureEvent failed unexpectedly', { error });
        // Return a safe rejected receipt
        const eventId = (event.eventId && typeof event.eventId === 'string')
            ? event.eventId
            : 'unknown';
        return {
            accepted: false,
            eventId,
            reason: 'internal_error',
            processed: Promise.resolve(false),
        };
    }
}
