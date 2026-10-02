/**
 * Single-flight coordinator — ensures only one execution of an asynchronous
 * operation (such as initialization or recovery) is active at any time.
 * Concurrent callers share the same in-flight Promise.
 */
export declare class SingleFlight<T> {
    private inFlight;
    isInFlight(): boolean;
    getPromise(): Promise<T> | null;
    execute(fn: () => Promise<T>): Promise<T>;
    setPromise(promise: Promise<T> | null): void;
    reset(): void;
}
