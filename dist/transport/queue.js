export class EventQueue {
    queue = [];
    maxSize;
    droppedCount = 0;
    deadLetterCount = 0;
    dropHandler = null;
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
    }
    configure(maxSize) {
        this.maxSize = Math.max(1, Math.floor(maxSize));
        while (this.queue.length > this.maxSize) {
            this.queue.shift();
            this.droppedCount += 1;
        }
    }
    add(event) {
        if (this.queue.length >= this.maxSize) {
            this.queue.shift();
            this.droppedCount += 1;
            this.notifyDrop("queue_full", 1);
        }
        this.queue.push(event);
    }
    drain(batchSize) {
        return this.queue.splice(0, batchSize);
    }
    size() {
        return this.queue.length;
    }
    getDroppedCount() {
        return this.droppedCount;
    }
    getDeadLetterCount() {
        return this.deadLetterCount;
    }
    drop(count) {
        const normalizedCount = Math.max(0, Math.floor(count));
        this.deadLetterCount += normalizedCount;
        this.notifyDrop("dead_letter", normalizedCount);
    }
    filter(predicate) {
        const before = this.queue.length;
        this.queue = this.queue.filter(predicate);
        const dropped = before - this.queue.length;
        this.droppedCount += dropped;
        this.notifyDrop("filtered", dropped);
    }
    clear() {
        this.queue = [];
    }
    onDrop(handler) {
        this.dropHandler = handler;
    }
    requeueFront(events) {
        const available = Math.max(0, this.maxSize - this.queue.length);
        const toRestore = events.slice(0, available);
        const dropped = events.length - toRestore.length;
        this.queue.unshift(...toRestore);
        this.droppedCount += dropped;
        this.notifyDrop("requeue_overflow", dropped);
    }
    notifyDrop(reason, count) {
        if (count <= 0)
            return;
        this.dropHandler?.({ reason, count });
    }
}
export const eventQueue = new EventQueue();
//# sourceMappingURL=queue.js.map