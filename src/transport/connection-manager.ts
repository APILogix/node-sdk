import type { EnterpriseRoute } from './route-registry.js'

export interface ConnectionManagerOptions {
  readonly maxTotalConnections: number
  readonly maxConnectionsPerRoute: Readonly<Record<EnterpriseRoute, number>>
  readonly connectionTimeoutMs: number
  readonly socketTimeoutMs: number
  readonly connectionTTLMs: number
  readonly idleConnectionTimeoutMs: number
}

export interface ConnectionLease {
  readonly route: EnterpriseRoute
  readonly acquiredAt: number
  release(healthy?: boolean): void
}

export interface ConnectionPoolStats {
  readonly maxTotalConnections: number
  readonly totalInUse: number
  readonly routeInUse: Readonly<Record<EnterpriseRoute, number>>
  readonly routeLimits: Readonly<Record<EnterpriseRoute, number>>
}

export class Semaphore {
  private available: number
  private readonly waiters = new Set<() => void>()

  constructor(private readonly capacity: number) {
    this.available = capacity
  }

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.available > 0) {
      this.available--
      return true
    }
    if (timeoutMs <= 0) return false

    return new Promise(resolve => {
      let settled = false
      const wake = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.waiters.delete(wake)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()

      this.waiters.add(wake)
    })
  }

  release(): void {
    const first = this.waiters.values().next()
    if (!first.done) {
      this.waiters.delete(first.value)
      first.value()
      return
    }
    this.available = Math.min(this.capacity, this.available + 1)
  }

  inUse(): number {
    return this.capacity - this.available
  }
}

export class ConnectionManager {
  private readonly globalSemaphore: Semaphore
  private readonly routeSemaphores: Map<EnterpriseRoute, Semaphore>
  private readonly routeInUse: Record<EnterpriseRoute, number> = {
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
  }
  private totalInUse = 0

  constructor(private readonly options: ConnectionManagerOptions) {
    this.globalSemaphore = new Semaphore(options.maxTotalConnections)
    this.routeSemaphores = new Map(
      (Object.entries(options.maxConnectionsPerRoute) as [EnterpriseRoute, number][])
        .map(([route, limit]) => [route, new Semaphore(limit)])
    )
  }

  async acquire(route: EnterpriseRoute): Promise<ConnectionLease | null> {
    const routeSemaphore = this.routeSemaphores.get(route)
    if (!routeSemaphore) return null

    const deadline = Date.now() + this.options.connectionTimeoutMs
    const routeAcquired = await routeSemaphore.acquire(this.options.connectionTimeoutMs)
    if (!routeAcquired) return null

    const remainingMs = Math.max(0, deadline - Date.now())
    const globalAcquired = await this.globalSemaphore.acquire(remainingMs)
    if (!globalAcquired) {
      routeSemaphore.release()
      return null
    }

    this.routeInUse[route]++
    this.totalInUse++
    let released = false

    return {
      route,
      acquiredAt: Date.now(),
      release: (_healthy = true) => {
        if (released) return
        released = true
        this.routeInUse[route] = Math.max(0, this.routeInUse[route] - 1)
        this.totalInUse = Math.max(0, this.totalInUse - 1)
        routeSemaphore.release()
        this.globalSemaphore.release()
      },
    }
  }

  getStats(): ConnectionPoolStats {
    return {
      maxTotalConnections: this.options.maxTotalConnections,
      totalInUse: this.totalInUse,
      routeInUse: { ...this.routeInUse },
      routeLimits: { ...this.options.maxConnectionsPerRoute },
    }
  }

  stats(): ConnectionPoolStats {
    return this.getStats()
  }

  getMaxForRoute(route: EnterpriseRoute): number {
    return this.options.maxConnectionsPerRoute[route]
  }

  maxForRoute(route: EnterpriseRoute): number {
    return this.getMaxForRoute(route)
  }
}
