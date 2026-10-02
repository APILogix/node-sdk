/**
 * Single-flight coordinator — ensures only one execution of an asynchronous
 * operation (such as initialization or recovery) is active at any time.
 * Concurrent callers share the same in-flight Promise.
 */
export class SingleFlight<T> {
  private inFlight: Promise<T> | null = null

  isInFlight(): boolean {
    return this.inFlight !== null
  }

  getPromise(): Promise<T> | null {
    return this.inFlight
  }

  execute(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      return this.inFlight
    }

    const promise = fn().finally(() => {
      if (this.inFlight === promise) {
        this.inFlight = null
      }
    })

    this.inFlight = promise
    return promise
  }

  setPromise(promise: Promise<T> | null): void {
    this.inFlight = promise
  }

  reset(): void {
    this.inFlight = null
  }
}
