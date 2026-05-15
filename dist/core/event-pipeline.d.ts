/**
 * Central event processing pipeline.
 *
 * Every captured event flows through this pipeline:
 *   capture → normalize → sanitize → enrich → plugin processors → beforeSend → sample → queue
 *
 * Each step is a pure function: (event) => event | null
 * Returning null drops the event from the pipeline.
 */
import type { SDKEvent, Event } from '../types/event.js';
/**
 * Process and enqueue an event through the full pipeline.
 * This is the single entry point for all event capture.
 *
 * Returns true if the event was queued, false if it was dropped.
 */
export declare function processEvent(rawEvent: SDKEvent | Event): boolean;
//# sourceMappingURL=event-pipeline.d.ts.map