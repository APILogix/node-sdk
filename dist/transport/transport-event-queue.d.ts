import type { SDKEvent } from '../types/event.js';
import type { EnterpriseRoute } from './route-registry.js';
export type QueuePriority = 'high' | 'normal' | 'low';
export type QueueDropReason = 'queue_full' | 'event_too_large' | 'serialization_failed' | 'transport_disabled' | 'route_unavailable';
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
}
export declare class TransportEventQueue {
    readonly route: EnterpriseRoute;
    readonly maxSize: number;
    readonly priority: QueuePriority;
    private readonly events;
    private readonly onDrop;
    private dropped;
    constructor(options: TransportEventQueueOptions);
    enqueue(event: SDKEvent): boolean;
    drain(maxEvents: number): SDKEvent[];
    requeueFront(events: readonly SDKEvent[]): void;
    size(): number;
    isEmpty(): boolean;
    clear(): void;
    droppedCount(): number;
}
//# sourceMappingURL=transport-event-queue.d.ts.map