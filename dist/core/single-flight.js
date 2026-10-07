/**
 * Single-flight coordinator — ensures only one execution of an asynchronous
 * operation (such as initialization or recovery) is active at any time.
 * Concurrent callers share the same in-flight Promise.
 */
export class SingleFlight {
    inFlight = null;
    isInFlight() {
        return this.inFlight !== null;
    }
    getPromise() {
        return this.inFlight;
    }
    execute(fn) {
        if (this.inFlight) {
            return this.inFlight;
        }
        const promise = fn().finally(() => {
            if (this.inFlight === promise) {
                this.inFlight = null;
            }
        });
        this.inFlight = promise;
        return promise;
    }
    setPromise(promise) {
        this.inFlight = promise;
    }
    reset() {
        this.inFlight = null;
    }
}
