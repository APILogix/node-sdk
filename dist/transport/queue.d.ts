/**
 * Enterprise Priority Event Queue — 3-tier priority with adaptive shedding.
 *
 * Priority tiers:
 *   - critical (40%): errors, crashes — never shed unless hard limit
 *   - high (40%): requests, spans — shed under critical pressure
 *   - normal (20%): metrics, messages, breadcrumbs — shed first
 *
 * Features:
 *   - Per-tier capacity limits with overflow protection
 *   - Retry queue with priority preservation
 *   - Shutdown safety — rejects new events when shutting down
 *   - Drain-to-disk for graceful shutdown
 *   - Dead letter tracking
 *   - Drop handler callbacks
 */
import type { Event } from '../types/event.js';
export type EventPriority = 'critical' | 'high' | 'normal';
export interface QueueStats {
    readonly totalSize: number;
    readonly criticalSize: number;
    readonly highSize: number;
    readonly normalSize: number;
    readonly retrySize: number;
    readonly droppedCount: number;
    readonly deadLetterCount: number;
    readonly isShuttingDown: boolean;
}
export declare class EventQueue {
    private tiers;
    private retryQueue;
    private maxSize;
    private deadLetterCount;
    private shuttingDown;
    private dropHandler;
    constructor(maxSize?: number);
    configure(maxSize: number): void;
    /**
     * Add an event to the queue. Priority auto-detected from event type.
     * Returns false if the event was dropped.
     */
    add(event: Event, priority?: EventPriority): boolean;
    addRetry(event: Event): boolean;
    /**
     * Drain events for a batch. Retry queue has highest priority,
     * then critical, high, normal.
     */
    drain(batchSize: number): Event[];
    drainAll(): Event[];
    size(): number;
    isEmpty(): boolean;
    getDroppedCount(): number;
    getDeadLetterCount(): number;
    drop(count: number): void;
    filter(predicate: (event: Event) => boolean): void;
    clear(): void;
    onDrop(handler: ((info: {
        reason: string;
        count: number;
    }) => void) | null): void;
    requeueFront(events: Event[]): void;
    /** Mark the queue as shutting down — rejects new events. */
    setShuttingDown(value: boolean): void;
    isShuttingDown(): boolean;
    /** Persist all remaining events to storage for crash recovery. */
    persistRemaining(persist: (event: Event) => void): Promise<void>;
    getStats(): QueueStats;
    /** Get queue utilization as a ratio (0.0–1.0) for pressure monitoring. */
    getUtilization(): number;
    private shedLowerPriority;
    private notifyDrop;
}
/**
 * Classify an event's priority based on its type.
 */
export declare function getPriority(event: Event | Record<string, unknown>): EventPriority;
export declare const eventQueue: EventQueue;
//# sourceMappingURL=queue.d.ts.map