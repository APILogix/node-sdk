/** Bounded ring-buffer queue with backend-controlled critical capacity. */
export class TransportEventQueue {
    route;
    maxSize;
    priority;
    overflowStrategy;
    criticalReserve;
    buffer;
    capacity;
    head = 0;
    count = 0;
    criticalCount = 0;
    onDrop;
    dropped = 0;
    constructor(options) {
        if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
            throw new RangeError('Transport queue maxSize must be a positive integer');
        }
        if (!Number.isInteger(options.criticalReserve)
            || options.criticalReserve < 0
            || options.criticalReserve > options.maxSize) {
            throw new RangeError('Transport queue criticalReserve must be an integer within queue capacity');
        }
        this.route = options.route;
        this.maxSize = options.maxSize;
        this.priority = options.priority;
        this.onDrop = options.onDrop;
        this.overflowStrategy = options.overflowStrategy;
        this.capacity = options.maxSize;
        this.criticalReserve = options.criticalReserve;
        this.buffer = new Array(this.capacity);
    }
    enqueue(event) {
        const incomingCritical = isCritical(event);
        const ordinaryCount = this.count - this.criticalCount;
        const ordinaryCapacity = this.capacity - this.criticalReserve;
        // Preserve the configured reserve even while the ring still has free slots.
        if (!incomingCritical && ordinaryCount >= ordinaryCapacity) {
            if (this.overflowStrategy === 'drop_oldest' && ordinaryCapacity > 0) {
                const offset = this.findOldestNonCritical();
                if (offset >= 0) {
                    const evicted = this.removeAt(offset);
                    this.append(event);
                    this.notifyDrop(evicted ?? event);
                    return true;
                }
            }
            this.notifyDrop(event);
            return false;
        }
        if (this.count >= this.capacity) {
            const evictOffset = this.findOldestNonCritical();
            if ((incomingCritical || this.overflowStrategy === 'drop_oldest') && evictOffset >= 0) {
                const evicted = this.removeAt(evictOffset);
                this.append(event);
                this.notifyDrop(evicted ?? event);
                return true;
            }
            this.notifyDrop(event);
            return false;
        }
        this.append(event);
        return true;
    }
    drain(maxEvents) {
        const amount = Math.min(maxEvents, this.count);
        if (amount <= 0)
            return [];
        const events = new Array(amount);
        for (let index = 0; index < amount; index++) {
            const slot = (this.head + index) % this.capacity;
            const event = this.buffer[slot];
            events[index] = event;
            if (isCritical(event))
                this.criticalCount--;
            this.buffer[slot] = undefined;
        }
        this.head = (this.head + amount) % this.capacity;
        this.count -= amount;
        return events;
    }
    /** Requeue failed events at the front while preserving critical reserve. */
    requeueFront(events) {
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (!event)
                continue;
            const critical = isCritical(event);
            const ordinaryCount = this.count - this.criticalCount;
            const ordinaryCapacity = this.capacity - this.criticalReserve;
            if (!critical && ordinaryCount >= ordinaryCapacity) {
                this.notifyDrop(event);
                continue;
            }
            if (this.count >= this.capacity) {
                if (!critical) {
                    this.notifyDrop(event);
                    continue;
                }
                const offset = this.findOldestNonCritical();
                if (offset < 0) {
                    this.notifyDrop(event);
                    continue;
                }
                const evicted = this.removeAt(offset);
                if (evicted)
                    this.notifyDrop(evicted);
            }
            this.prepend(event);
        }
    }
    append(event) {
        const tail = (this.head + this.count) % this.capacity;
        this.buffer[tail] = event;
        this.count++;
        if (isCritical(event))
            this.criticalCount++;
    }
    prepend(event) {
        this.head = (this.head - 1 + this.capacity) % this.capacity;
        this.buffer[this.head] = event;
        this.count++;
        if (isCritical(event))
            this.criticalCount++;
    }
    findOldestNonCritical() {
        for (let offset = 0; offset < this.count; offset++) {
            const event = this.buffer[(this.head + offset) % this.capacity];
            if (event && !isCritical(event))
                return offset;
        }
        return -1;
    }
    removeAt(offset) {
        if (offset < 0 || offset >= this.count)
            return undefined;
        const removed = this.buffer[(this.head + offset) % this.capacity];
        if (offset === 0) {
            this.buffer[this.head] = undefined;
            this.head = (this.head + 1) % this.capacity;
        }
        else {
            for (let index = offset; index < this.count - 1; index++) {
                const destination = (this.head + index) % this.capacity;
                const source = (this.head + index + 1) % this.capacity;
                this.buffer[destination] = this.buffer[source];
            }
            this.buffer[(this.head + this.count - 1) % this.capacity] = undefined;
        }
        this.count--;
        if (removed && isCritical(removed))
            this.criticalCount--;
        return removed;
    }
    notifyDrop(event) {
        this.dropped++;
        this.onDrop?.({
            route: this.route,
            reason: 'queue_full',
            count: 1,
            eventType: event.type,
            eventId: event.eventId,
            critical: isCritical(event),
        });
    }
    size() {
        return this.count;
    }
    isEmpty() {
        return this.count === 0;
    }
    clear() {
        this.buffer = new Array(this.capacity);
        this.head = 0;
        this.count = 0;
        this.criticalCount = 0;
    }
    droppedCount() {
        return this.dropped;
    }
}
function isCritical(event) {
    if (event.type === 'error')
        return event.severity === 'fatal';
    if (event.type === 'log')
        return event.level === 'fatal';
    return event.type === 'cron_checkin' && event.status === 'error';
}
