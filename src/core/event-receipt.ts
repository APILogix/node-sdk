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

/**
 * Acknowledgment object returned when an event enters the processing pipeline.
 *
 * The pipeline is intentionally async and non-blocking — `accepted: true` means
 * the event was admitted into the deferred processing queue, NOT that it has
 * been fully processed, exported, or persisted.
 *
 * Use `receipt.processed` only when you need to await full pipeline completion
 * (e.g., during `flush()` or graceful shutdown).
 */
export interface EventReceipt {
  /** Whether the event was accepted into the pipeline. */
  readonly accepted: boolean

  /** Assigned event ID — available immediately, even before processing. */
  readonly eventId: string

  /**
   * Human-readable reason for rejection.
   * Only present when `accepted === false`.
   */
  readonly reason?: string | undefined

  /**
   * Promise that resolves to `true` when async processing completes successfully,
   * or `false` if the event was dropped during pipeline processing.
   *
   * For fire-and-forget capture, ignore this promise.
   * For flush/drain/shutdown, await it to ensure delivery.
   */
  readonly processed: Promise<boolean>
}

// ─── Factory Helpers ────────────────────────────────────────────────────────

/** Already-resolved promise for synchronous rejection receipts (zero allocation on hot path). */
const REJECTED_PROMISE = Promise.resolve(false)
const ACCEPTED_SYNC_PROMISE = Promise.resolve(true)

/**
 * Create a receipt for an accepted event.
 * The `processed` promise is provided by the caller (the async pipeline).
 */
export function acceptedReceipt(eventId: string, processed: Promise<boolean>): EventReceipt {
  return { accepted: true, eventId, processed }
}

/**
 * Create a receipt for a synchronously accepted event (e.g., pre-init buffer).
 * Processing is considered complete at acceptance time.
 */
export function acceptedSyncReceipt(eventId: string): EventReceipt {
  return { accepted: true, eventId, processed: ACCEPTED_SYNC_PROMISE }
}

/**
 * Create a receipt for a rejected/dropped event.
 * Uses a pre-resolved promise to avoid allocation.
 */
export function rejectedReceipt(eventId: string, reason: string): EventReceipt {
  return { accepted: false, eventId, reason, processed: REJECTED_PROMISE }
}
