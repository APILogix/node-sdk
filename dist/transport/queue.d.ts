type Event = any;
declare class EventQueue {
    private queue;
    private maxSize;
    add(event: Event): void;
    drain(batchSize: number): Event[];
    size(): number;
}
export declare const eventQueue: EventQueue;
export {};
//# sourceMappingURL=queue.d.ts.map