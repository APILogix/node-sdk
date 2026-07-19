import type { SDKEvent } from '../types/event.js';
import type { EnterpriseRoute } from './route-registry.js';
export type QueuePriority = 'high' | 'normal' | 'low';
export type QueueDropReason = 'queue_full' | 'event_too_large' | 'serialization_failed' | 'transport_disabled' | 'route_unavailable' | 'route_unconfigured';
export type QueueOverflowStrategy = 'drop_oldest' | 'drop_newest';
export interface QueueDropInfo {
    readonly route: EnterpriseRoute;
    readonly reason: QueueDropReason;
    readonly count: number;
    readonly eventType?: string | undefined;
}
export interface TransportEventQueueOptions {
    readonly route: EnterpriseRoute;
    readonly maxSize: number;
    readonly priority: QueuePriority;
    readonly onDrop?: (info: QueueDropInfo) => void;
    /**
     * What to do when the queue is full. Driven by remote config
     * (`transport.queue.overflowStrategy`). Defaults to 'drop_newest'
     * (reject the incoming event) to preserve pre-existing behaviour.
     */
    readonly overflowStrategy?: QueueOverflowStrategy;
}
/**
 * Bounded event queue backed by a ring buffer.
 *
 * Every hot-path operation is O(1): `enqueue` writes at the tail,
 * `drain` advances the head index, and `drop_oldest` eviction just moves
 * the head forward. The previous array-based implementation used
 * `Array.shift()` for drop_oldest, which is O(capacity) per evicted event
 * — under sustained overflow (e.g. a backlogged traces route dropping
 * tens of thousands of spans) that quadratic cost froze the event loop
 * and delayed unrelated routes sharing the process.
 */
export declare class TransportEventQueue {
    readonly route: EnterpriseRoute;
    readonly maxSize: number;
    readonly priority: QueuePriority;
    private readonly overflowStrategy;
    private buffer;
    private readonly capacity;
    private head;
    private count;
    private readonly onDrop;
    private dropped;
    constructor(options: TransportEventQueueOptions);
    enqueue(event: SDKEvent): boolean;
    drain(maxEvents: number): SDKEvent[];
    /**
     * Put a failed batch back at the front of the queue, preserving order.
     *
     * When capacity is short, the HEAD of the requeued batch (its oldest
     * events) is dropped — identical semantics to the previous
     * per-event `unshift` loop, but O(batch) total instead of O(n²).
     */
    requeueFront(events: readonly SDKEvent[]): void;
    size(): number;
    isEmpty(): boolean;
    clear(): void;
    droppedCount(): number;
}
//# sourceMappingURL=transport-event-queue.d.ts.map