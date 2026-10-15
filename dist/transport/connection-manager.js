export class Semaphore {
    capacity;
    available;
    waiters = new Set();
    constructor(capacity) {
        this.capacity = capacity;
        this.available = capacity;
    }
    async acquire(timeoutMs) {
        if (this.available > 0) {
            this.available--;
            return true;
        }
        if (timeoutMs <= 0)
            return false;
        return new Promise(resolve => {
            let settled = false;
            const wake = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve(true);
            };
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                this.waiters.delete(wake);
                resolve(false);
            }, timeoutMs);
            timer.unref?.();
            this.waiters.add(wake);
        });
    }
    release() {
        const first = this.waiters.values().next();
        if (!first.done) {
            this.waiters.delete(first.value);
            first.value();
            return;
        }
        this.available = Math.min(this.capacity, this.available + 1);
    }
    inUse() {
        return this.capacity - this.available;
    }
}
export class ConnectionManager {
    options;
    globalSemaphore;
    routeSemaphores;
    routeInUse = {
        errors: 0,
        events: 0,
        traces: 0,
        spans: 0,
        metrics: 0,
        logs: 0,
        profiles: 0,
        crons: 0,
        requests: 0,
        replays: 0,
    };
    totalInUse = 0;
    constructor(options) {
        this.options = options;
        this.globalSemaphore = new Semaphore(options.maxTotalConnections);
        this.routeSemaphores = new Map(Object.entries(options.maxConnectionsPerRoute)
            .map(([route, limit]) => [route, new Semaphore(limit)]));
    }
    async acquire(route) {
        const routeSemaphore = this.routeSemaphores.get(route);
        if (!routeSemaphore)
            return null;
        const deadline = Date.now() + this.options.connectionTimeoutMs;
        const routeAcquired = await routeSemaphore.acquire(this.options.connectionTimeoutMs);
        if (!routeAcquired)
            return null;
        const remainingMs = Math.max(0, deadline - Date.now());
        const globalAcquired = await this.globalSemaphore.acquire(remainingMs);
        if (!globalAcquired) {
            routeSemaphore.release();
            return null;
        }
        this.routeInUse[route]++;
        this.totalInUse++;
        let released = false;
        return {
            route,
            acquiredAt: Date.now(),
            release: (_healthy = true) => {
                if (released)
                    return;
                released = true;
                this.routeInUse[route] = Math.max(0, this.routeInUse[route] - 1);
                this.totalInUse = Math.max(0, this.totalInUse - 1);
                routeSemaphore.release();
                this.globalSemaphore.release();
            },
        };
    }
    getStats() {
        return {
            maxTotalConnections: this.options.maxTotalConnections,
            totalInUse: this.totalInUse,
            routeInUse: { ...this.routeInUse },
            routeLimits: { ...this.options.maxConnectionsPerRoute },
        };
    }
    stats() {
        return this.getStats();
    }
    getMaxForRoute(route) {
        return this.options.maxConnectionsPerRoute[route];
    }
    maxForRoute(route) {
        return this.getMaxForRoute(route);
    }
}
