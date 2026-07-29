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
export class TransportEventQueue {
    route;
    maxSize;
    priority;
    overflowStrategy;
    buffer;
    capacity;
    head = 0;
    count = 0;
    onDrop;
    dropped = 0;
    constructor(options) {
        this.route = options.route;
        this.maxSize = options.maxSize;
        this.priority = options.priority;
        this.onDrop = options.onDrop;
        this.overflowStrategy = options.overflowStrategy ?? 'drop_newest';
        this.capacity = Math.max(1, options.maxSize);
        this.buffer = new Array(this.capacity);
    }
    enqueue(event) {
        if (this.count >= this.capacity) {
            const incomingCritical = isCritical(event);
            const evictOffset = this.findOldestNonCritical();
            // Critical telemetry may evict ordinary telemetry under either
            // overflow policy. Ordinary telemetry can never evict a critical item.
            if (incomingCritical && evictOffset >= 0) {
                const evicted = this.removeAt(evictOffset);
                this.append(event);
                this.notifyDrop(evicted ?? event);
                return true;
            }
            if (this.overflowStrategy === 'drop_oldest' && evictOffset >= 0) {
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
        const n = Math.min(maxEvents, this.count);
        if (n <= 0)
            return [];
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            const idx = (this.head + i) % this.capacity;
            out[i] = this.buffer[idx];
            this.buffer[idx] = undefined; // release the reference for GC
        }
        this.head = (this.head + n) % this.capacity;
        this.count -= n;
        return out;
    }
    /**
     * Put a failed batch back at the front of the queue, preserving order.
     *
     * When capacity is short, the HEAD of the requeued batch (its oldest
     * events) is dropped — identical semantics to the previous
     * per-event `unshift` loop, but O(batch) total instead of O(n²).
     */
    requeueFront(events) {
        if (events.length === 0)
            return;
        // Insert in reverse to preserve original batch order at the front.
        // On saturation, retrying ordinary events never displaces critical data;
        // retrying critical events may evict the oldest ordinary item.
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (!event)
                continue;
            if (this.count >= this.capacity) {
                if (isCritical(event)) {
                    const offset = this.findOldestNonCritical();
                    if (offset >= 0) {
                        const evicted = this.removeAt(offset);
                        if (evicted)
                            this.notifyDrop(evicted);
                    }
                    else {
                        this.notifyDrop(event);
                        continue;
                    }
                }
                else {
                    this.notifyDrop(event);
                    continue;
                }
            }
            this.head = (this.head - 1 + this.capacity) % this.capacity;
            this.buffer[this.head] = event;
            this.count++;
        }
    }
    append(event) {
        const tail = (this.head + this.count) % this.capacity;
        this.buffer[tail] = event;
        this.count++;
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
        if (offset === 0) {
            const removed = this.buffer[this.head];
            this.buffer[this.head] = undefined;
            this.head = (this.head + 1) % this.capacity;
            this.count--;
            return removed;
        }
        const removed = this.buffer[(this.head + offset) % this.capacity];
        for (let i = offset; i < this.count - 1; i++) {
            const to = (this.head + i) % this.capacity;
            const from = (this.head + i + 1) % this.capacity;
            this.buffer[to] = this.buffer[from];
        }
        const tail = (this.head + this.count - 1) % this.capacity;
        this.buffer[tail] = undefined;
        this.count--;
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
