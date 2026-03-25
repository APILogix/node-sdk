class EventQueue {
    queue = [];
    maxSize = 1000;
    add(event) {
        if (this.queue.length >= this.maxSize) {
            //  drop oldest (backpressure strategy)
            this.queue.shift();
        }
        this.queue.push(event);
    }
    drain(batchSize) {
        return this.queue.splice(0, batchSize);
    }
    size() {
        return this.queue.length;
    }
}
export const eventQueue = new EventQueue();
//# sourceMappingURL=queue.js.map