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

class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(private readonly capacity: number) {
    this.available = capacity
  }

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.available > 0) {
      this.available--
      return true
    }

    return new Promise(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const index = this.waiters.indexOf(wake)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()

      const wake = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.available--
        resolve(true)
      }

      this.waiters.push(wake)
    })
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()
      next?.()
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
    traces: 0,
    metrics: 0,
    logs: 0,
    profiles: 0,
    crons: 0,
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

    const routeAcquired = await routeSemaphore.acquire(this.options.connectionTimeoutMs)
    if (!routeAcquired) return null

    const globalAcquired = await this.globalSemaphore.acquire(this.options.connectionTimeoutMs)
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

  stats(): ConnectionPoolStats {
    return {
      maxTotalConnections: this.options.maxTotalConnections,
      totalInUse: this.totalInUse,
      routeInUse: { ...this.routeInUse },
      routeLimits: { ...this.options.maxConnectionsPerRoute },
    }
  }

  maxForRoute(route: EnterpriseRoute): number {
    return this.options.maxConnectionsPerRoute[route]
  }
}
