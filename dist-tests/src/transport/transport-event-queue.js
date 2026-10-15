/** O(1) circular ring buffer with zero element shifting. */
class InternalRing {
    cap;
    buf;
    head = 0;
    len = 0;
    constructor(cap) {
        this.cap = cap;
        this.buf = new Array(cap);
    }
    get length() {
        return this.len;
    }
    pushBack(item) {
        const tail = (this.head + this.len) % this.cap;
        this.buf[tail] = item;
        this.len++;
    }
    pushFront(item) {
        this.head = (this.head - 1 + this.cap) % this.cap;
        this.buf[this.head] = item;
        this.len++;
    }
    popFront() {
        if (this.len === 0)
            return undefined;
        const item = this.buf[this.head];
        this.buf[this.head] = undefined;
        this.head = (this.head + 1) % this.cap;
        this.len--;
        return item;
    }
    peekFront() {
        return this.len === 0 ? undefined : this.buf[this.head];
    }
    clear() {
        this.buf = new Array(this.cap);
        this.head = 0;
        this.len = 0;
    }
}
/** Bounded O(1) dual-ring queue with backend-controlled critical capacity. */
export class TransportEventQueue {
    route;
    maxSize;
    priority;
    overflowStrategy;
    criticalReserve;
    capacity;
    criticalRing;
    ordinaryRing;
    nextTailSeq = 1;
    nextHeadSeq = 0;
    onDrop;
    dropped = 0;
    constructor(options) {
        if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
            throw new RangeError('Transport queue maxSize must be a positive integer');
        }
        if (!Number.isInteger(options.criticalReserve) ||
            options.criticalReserve < 0 ||
            options.criticalReserve > options.maxSize) {
            throw new RangeError('Transport queue criticalReserve must be an integer within queue capacity');
        }
        this.route = options.route;
        this.maxSize = options.maxSize;
        this.priority = options.priority;
        this.onDrop = options.onDrop;
        this.overflowStrategy = options.overflowStrategy;
        this.capacity = options.maxSize;
        this.criticalReserve = options.criticalReserve;
        this.criticalRing = new InternalRing(this.capacity);
        this.ordinaryRing = new InternalRing(this.capacity);
    }
    enqueue(event) {
        const incomingCritical = isCritical(event);
        const ordinaryCount = this.ordinaryRing.length;
        const ordinaryCapacity = this.capacity - this.criticalReserve;
        const totalCount = this.criticalRing.length + ordinaryCount;
        // 1. Ordinary event hitting ordinary capacity limit (preserving criticalReserve)
        if (!incomingCritical && ordinaryCount >= ordinaryCapacity) {
            if (this.overflowStrategy === 'drop_oldest' && ordinaryCapacity > 0 && ordinaryCount > 0) {
                const evicted = this.ordinaryRing.popFront();
                this.ordinaryRing.pushBack({ event, seq: this.nextTailSeq++ });
                this.notifyDrop(evicted.event);
                return true;
            }
            this.notifyDrop(event);
            return false;
        }
        // 2. Total queue at full capacity
        if (totalCount >= this.capacity) {
            if ((incomingCritical || this.overflowStrategy === 'drop_oldest') && ordinaryCount > 0) {
                const evicted = this.ordinaryRing.popFront();
                if (incomingCritical) {
                    this.criticalRing.pushBack({ event, seq: this.nextTailSeq++ });
                }
                else {
                    this.ordinaryRing.pushBack({ event, seq: this.nextTailSeq++ });
                }
                this.notifyDrop(evicted.event);
                return true;
            }
            this.notifyDrop(event);
            return false;
        }
        // 3. Normal O(1) append
        if (incomingCritical) {
            this.criticalRing.pushBack({ event, seq: this.nextTailSeq++ });
        }
        else {
            this.ordinaryRing.pushBack({ event, seq: this.nextTailSeq++ });
        }
        return true;
    }
    drain(maxEvents) {
        const totalCount = this.criticalRing.length + this.ordinaryRing.length;
        const amount = Math.min(maxEvents, totalCount);
        if (amount <= 0)
            return [];
        const events = new Array(amount);
        for (let i = 0; i < amount; i++) {
            const crit = this.criticalRing.peekFront();
            const ord = this.ordinaryRing.peekFront();
            if (crit && (!ord || crit.seq < ord.seq)) {
                events[i] = this.criticalRing.popFront().event;
            }
            else {
                events[i] = this.ordinaryRing.popFront().event;
            }
        }
        return events;
    }
    /**
     * Requeue failed events at the front while preserving critical reserve.
     * Strict O(k) time with zero full-buffer allocations or array shifts.
     */
    requeueFront(events) {
        if (!events || events.length === 0)
            return;
        const ordinaryCapacity = this.capacity - this.criticalReserve;
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (!event)
                continue;
            const critical = isCritical(event);
            const totalCount = this.criticalRing.length + this.ordinaryRing.length;
            if (!critical) {
                if (this.ordinaryRing.length >= ordinaryCapacity || totalCount >= this.capacity) {
                    this.notifyDrop(event);
                    continue;
                }
                this.ordinaryRing.pushFront({ event, seq: this.nextHeadSeq-- });
            }
            else {
                if (totalCount >= this.capacity) {
                    if (this.ordinaryRing.length > 0) {
                        const evicted = this.ordinaryRing.popFront();
                        this.notifyDrop(evicted.event);
                        this.criticalRing.pushFront({ event, seq: this.nextHeadSeq-- });
                    }
                    else {
                        this.notifyDrop(event);
                    }
                }
                else {
                    this.criticalRing.pushFront({ event, seq: this.nextHeadSeq-- });
                }
            }
        }
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
    getSize() {
        return this.criticalRing.length + this.ordinaryRing.length;
    }
    size() {
        return this.criticalRing.length + this.ordinaryRing.length;
    }
    isEmpty() {
        return this.size() === 0;
    }
    clear() {
        this.criticalRing.clear();
        this.ordinaryRing.clear();
        this.nextTailSeq = 1;
        this.nextHeadSeq = 0;
    }
    droppedCount() {
        return this.dropped;
    }
}
function isCritical(event) {
    if (event.type === 'error') {
        return event.severity === 'fatal' || event.classification?.fatal === true;
    }
    if (event.type === 'log')
        return event.level === 'fatal';
    return event.type === 'cron_checkin' && event.status === 'error';
}
