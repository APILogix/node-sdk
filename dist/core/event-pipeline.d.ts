/**
 * Central event processing pipeline — async, non-blocking, priority-governed.
 *
 * Architecture:
 *   Every captured event flows through a deferred async pipeline:
 *     capture → accept → [setImmediate] → normalize → sanitize → enrich →
 *     dedup → scope → plugin processors → beforeSend → route → persist
 *
 * Lifecycle model:
 *   1. `enqueueEvent()` synchronously validates and accepts the event,
 *      returning an `EventReceipt` with `accepted` status and `eventId`.
 *   2. Processing is deferred via `setImmediate()` to avoid blocking the
 *      caller's request lifecycle (critical for low-latency capture).
 *   3. The `receipt.processed` promise resolves when async processing completes.
 *   4. `processEvent()` is a backward-compatible wrapper returning `boolean`.
 *
 * Persistence governance:
 *   Events are persisted selectively via `PersistenceGovernor`:
 *     - critical (errors, crashes): always persisted for crash recovery
 *     - important (spans, requests): persisted unless high memory pressure
 *     - transient (metrics, messages): persisted only under normal pressure
 *   This prevents disk I/O from becoming a throughput bottleneck at scale.
 *
 * Load shedding & Correlation Groups:
 *   The pipeline integrates with `LoadShedder` and `AdaptivePressureMonitor`
 *   to drop low-priority telemetry under system pressure at the correlation-group
 *   level before any expensive processing occurs.
 *
 * Quota Control:
 *   Integrated with `QuotaController` to gracefully suppress billable telemetry
 *   during exhaustion while preserving application execution and SDK runtime.
 *
 * Replay safety:
 *   Persisted events are replayed on SDK restart via `PersistentStorage`.
 *   The `PersistenceGovernor` bounds replay pressure by limiting what gets
 *   persisted in the first place.
 *
 * Each pipeline step is a pure function: (event) => event | null
 * Returning null drops the event from the pipeline.
 */
import type { SDKEvent, Event } from '../types/event.js';
import { type EventReceipt } from './event-receipt.js';
/**
 * Accept an event into the processing pipeline and return an EventReceipt.
 *
 * This is the preferred entry point for event capture. It provides clear
 * async acceptance semantics:
 *
 * - `receipt.accepted` — event entered the pipeline (synchronous)
 * - `receipt.eventId` — assigned event ID for correlation
 * - `receipt.reason` — why the event was rejected (if `accepted === false`)
 * - `receipt.processed` — promise resolving when processing completes
 *
 * The pipeline is intentionally non-blocking. Processing is deferred via
 * `setImmediate()` to avoid blocking the caller's request lifecycle.
 */
export declare function enqueueEvent(rawEvent: SDKEvent | Event): EventReceipt;
/**
 * Process and enqueue an event through the full pipeline.
 *
 * **Backward-compatible wrapper** — returns `true` if the event was accepted
 * into the pipeline, `false` if it was synchronously rejected.
 */
export declare function processEvent(rawEvent: SDKEvent | Event): boolean;
/**
 * Drain in-flight pipeline work to completion.
 * @param rejectNew Whether to reject new incoming events while draining (true during shutdown, false during flush).
 */
export declare function drainPendingEventProcessing(rejectNew?: boolean): Promise<void>;
/**
 * Reset the pipeline-draining flag.
 */
export declare function resetEventPipeline(): void;
/**
 * Async pipeline — processes a single event through all pipeline stages.
 */
export declare function processEventAsync(rawEvent: SDKEvent | Event, assignedEventId?: string): Promise<boolean>;
