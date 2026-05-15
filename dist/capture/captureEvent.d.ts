/**
 * Universal event capture — the single entry point for all SDK event ingestion.
 *
 * All other capture functions (captureError, captureRequest, captureMessage, captureMetric)
 * delegate to this function, which routes events through the processing pipeline.
 */
import type { SDKEvent, Event } from '../types/event.js';
/**
 * Capture an event and route it through the full processing pipeline.
 *
 * @param event - Any SDK event (error, request, message, metric, or custom)
 * @returns true if the event was accepted into the queue, false if dropped
 */
export declare function captureEvent(event: SDKEvent | Event): boolean;
//# sourceMappingURL=captureEvent.d.ts.map