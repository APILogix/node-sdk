import type { Event } from "../types/event.js";
export declare class EventQueue {
    private queue;
    private maxSize;
    private droppedCount;
    private deadLetterCount;
    private dropHandler;
    constructor(maxSize?: number);
    configure(maxSize: number): void;
    add(event: Event): void;
    drain(batchSize: number): Event[];
    size(): number;
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
    private notifyDrop;
}
export declare const eventQueue: EventQueue;
//# sourceMappingURL=queue.d.ts.map