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
    readonly eventId?: string | undefined;
    readonly critical?: boolean | undefined;
}
export interface TransportEventQueueOptions {
    readonly route: EnterpriseRoute;
    readonly maxSize: number;
    /** Slots unavailable to ordinary telemetry and reserved for critical events. */
    readonly criticalReserve: number;
    readonly priority: QueuePriority;
    readonly onDrop?: (info: QueueDropInfo) => void;
    readonly overflowStrategy: QueueOverflowStrategy;
}
/** Bounded ring-buffer queue with backend-controlled critical capacity. */
export declare class TransportEventQueue {
    readonly route: EnterpriseRoute;
    readonly maxSize: number;
    readonly priority: QueuePriority;
    private readonly overflowStrategy;
    private readonly criticalReserve;
    private buffer;
    private readonly capacity;
    private head;
    private count;
    private criticalCount;
    private readonly onDrop;
    private dropped;
    constructor(options: TransportEventQueueOptions);
    enqueue(event: SDKEvent): boolean;
    drain(maxEvents: number): SDKEvent[];
    /**
     * Requeue failed events at the front while preserving critical reserve.
     * Runs in O(n + k) linear time instead of O(n * k) under queue pressure (SEC-07).
     */
    requeueFront(events: readonly SDKEvent[]): void;
    private append;
    private prepend;
    private findOldestNonCritical;
    private removeAt;
    private notifyDrop;
    getSize(): number;
    size(): number;
    isEmpty(): boolean;
    clear(): void;
    droppedCount(): number;
}
