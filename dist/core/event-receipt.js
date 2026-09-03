/**
 * EventReceipt — lightweight acknowledgment value returned by the event pipeline.
 *
 * Provides clear async acceptance semantics:
 *   - `accepted`: event entered the pipeline (does NOT mean processed or exported)
 *   - `eventId`: assigned identifier for correlation
 *   - `reason`: human-readable rejection reason (only when `accepted === false`)
 *   - `processed`: promise resolving when async processing completes
 *
 * This design preserves the non-blocking pipeline architecture while giving
 * callers unambiguous lifecycle visibility:
 *
 *   const receipt = enqueueEvent(event)
 *   if (!receipt.accepted) log('dropped:', receipt.reason)
 *   await receipt.processed  // only if you need to wait for full processing
 */
// ─── Factory Helpers ────────────────────────────────────────────────────────
/** Already-resolved promise for synchronous rejection receipts (zero allocation on hot path). */
const REJECTED_PROMISE = Promise.resolve(false);
const ACCEPTED_SYNC_PROMISE = Promise.resolve(true);
/**
 * Create a receipt for an accepted event.
 * The `processed` promise is provided by the caller (the async pipeline).
 */
export function acceptedReceipt(eventId, processed) {
    return { accepted: true, eventId, processed };
}
/**
 * Create a receipt for a synchronously accepted event (e.g., pre-init buffer).
 * Processing is considered complete at acceptance time.
 */
export function acceptedSyncReceipt(eventId) {
    return { accepted: true, eventId, processed: ACCEPTED_SYNC_PROMISE };
}
/**
 * Create a receipt for a rejected/dropped event.
 * Uses a pre-resolved promise to avoid allocation.
 */
export function rejectedReceipt(eventId, reason) {
    return { accepted: false, eventId, reason, processed: REJECTED_PROMISE };
}
