export class TransportEventQueue {
    route;
    maxSize;
    priority;
    events = [];
    onDrop;
    dropped = 0;
    constructor(options) {
        this.route = options.route;
        this.maxSize = options.maxSize;
        this.priority = options.priority;
        this.onDrop = options.onDrop;
    }
    enqueue(event) {
        if (this.events.length >= this.maxSize) {
            this.dropped++;
            this.onDrop?.({ route: this.route, reason: 'queue_full', count: 1, eventType: event.type });
            return false;
        }
        this.events.push(event);
        return true;
    }
    drain(maxEvents) {
        if (maxEvents <= 0 || this.events.length === 0)
            return [];
        return this.events.splice(0, maxEvents);
    }
    requeueFront(events) {
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (!event)
                continue;
            if (this.events.length >= this.maxSize) {
                this.dropped++;
                this.onDrop?.({ route: this.route, reason: 'queue_full', count: 1, eventType: event.type });
                continue;
            }
            this.events.unshift(event);
        }
    }
    size() {
        return this.events.length;
    }
    isEmpty() {
        return this.events.length === 0;
    }
    clear() {
        this.events.length = 0;
    }
    droppedCount() {
        return this.dropped;
    }
}
