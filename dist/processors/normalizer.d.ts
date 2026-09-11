/**
 * Event normalizer — ensures all events have required fields with safe defaults.
 * Truncates oversized strings and limits object depth to prevent memory issues.
 */
import type { SDKEvent, EventMetadata } from '../types/event.js';
/**
 * Normalize an event — fills in missing required fields, truncates oversized data.
 */
export declare function normalizeEvent(event: SDKEvent, metadata: EventMetadata): SDKEvent;
