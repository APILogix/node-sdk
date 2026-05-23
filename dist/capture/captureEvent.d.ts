/**
 * Universal event capture — the single entry point for all SDK event ingestion.
 *
 * All other capture functions (captureError, captureRequest, captureMessage, captureMetric)
 * delegate to this function, which routes events through the processing pipeline.
 */
import type { SDKEvent, Event } from '../types/event.js';
import type { EventReceipt } from '../core/event-receipt.js';
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
export declare function captureEvent(event: SDKEvent | Event): EventReceipt;
//# sourceMappingURL=captureEvent.d.ts.map