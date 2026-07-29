import type { EnterpriseRoute } from './route-registry.js'

export type RouteHealthState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE'
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface RouteHealthSnapshot {
  readonly route: EnterpriseRoute
  readonly healthState: RouteHealthState
  readonly circuitState: CircuitState
  readonly failureCount: number
  readonly avgLatencyMs: number
  readonly p99LatencyMs: number
  readonly nextProbeAt: number | null
  readonly lastErrorAt: number | null
  readonly lastSuccessAt: number | null
}

const FAILURE_WINDOW_MS = 60_000
const FAILURE_THRESHOLD = 10
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const P99_DEGRADED_THRESHOLD_MS = 5_000
const P99_RECOVERY_THRESHOLD_MS = 4_000
const MIN_LATENCY_SAMPLES = 20
const MAX_LATENCY_SAMPLES = 200
const HISTOGRAM_BUCKETS = 256
const HISTOGRAM_SCALE = 16

class RouteHealth {
  private state: RouteHealthState = 'HEALTHY'
  private circuit: CircuitState = 'CLOSED'
  private readonly failures: number[] = []
  private readonly latencies: Array<{ value: number; bucket: number }> = []
  private readonly latencyHistogram = new Uint32Array(HISTOGRAM_BUCKETS)
  private latencySum = 0
  private backoffMs = INITIAL_BACKOFF_MS
  private probeInFlight = false
  private openUntil = 0
  private lastError: number | null = null
  private lastSuccess: number | null = null

  constructor(readonly route: EnterpriseRoute) {}

  canSend(): boolean {
    if (this.circuit !== 'OPEN') return true
    const now = Date.now()
    if (now < this.openUntil || this.probeInFlight) return false
    this.circuit = 'HALF_OPEN'
    this.probeInFlight = true
    return true
  }

  recordSuccess(latencyMs: number): void {
    this.lastSuccess = Date.now()
    this.probeInFlight = false
    this.failures.length = 0
    this.trackLatency(latencyMs)
    this.circuit = 'CLOSED'
    const p99 = this.p99Latency()
    const threshold = this.state === 'DEGRADED' ? P99_RECOVERY_THRESHOLD_MS : P99_DEGRADED_THRESHOLD_MS
    this.state = this.latencies.length >= MIN_LATENCY_SAMPLES && p99 > threshold ? 'DEGRADED' : 'HEALTHY'
    this.backoffMs = INITIAL_BACKOFF_MS
  }

  recordFailure(): void {
    const now = Date.now()
    this.lastError = now
    this.probeInFlight = false
    this.failures.push(now)
    this.pruneFailures(now)

    if (this.failures.length >= FAILURE_THRESHOLD || this.circuit === 'HALF_OPEN') {
      this.state = 'UNAVAILABLE'
      this.circuit = 'OPEN'
      this.openUntil = now + this.backoffMs
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2)
      return
    }

    this.state = 'DEGRADED'
  }

  concurrencyScale(): number {
    if (this.state === 'HEALTHY') return 1
    if (this.state === 'DEGRADED') return 0.5
    return this.canSend() ? 0.05 : 0
  }

  batchScale(): number {
    if (this.state === 'DEGRADED') return 0.5
    if (this.state === 'UNAVAILABLE') return 2
    return 1
  }

  snapshot(): RouteHealthSnapshot {
    const now = Date.now()
    this.pruneFailures(now)
    return {
      route: this.route,
      healthState: this.state,
      circuitState: this.circuit,
      failureCount: this.failures.length,
      avgLatencyMs: this.latencies.length > 0 ? this.latencySum / this.latencies.length : 0,
      p99LatencyMs: this.p99Latency(),
      nextProbeAt: this.circuit === 'OPEN' ? this.openUntil : null,
      lastErrorAt: this.lastError,
      lastSuccessAt: this.lastSuccess,
    }
  }

  private trackLatency(latencyMs: number): void {
    const value = Math.max(0, latencyMs)
    const bucket = Math.min(
      HISTOGRAM_BUCKETS - 1,
      Math.floor(Math.log2(value + 1) * HISTOGRAM_SCALE),
    )
    this.latencies.push({ value, bucket })
    this.latencyHistogram[bucket] = (this.latencyHistogram[bucket] ?? 0) + 1
    this.latencySum += value

    if (this.latencies.length > MAX_LATENCY_SAMPLES) {
      const removed = this.latencies.shift()
      if (removed) {
        this.latencyHistogram[removed.bucket] = Math.max(0, (this.latencyHistogram[removed.bucket] ?? 0) - 1)
        this.latencySum -= removed.value
      }
    }
  }

  private p99Latency(): number {
    if (this.latencies.length === 0) return 0
    const target = Math.max(1, Math.ceil(this.latencies.length * 0.99))
    let seen = 0
    for (let bucket = 0; bucket < this.latencyHistogram.length; bucket++) {
      seen += this.latencyHistogram[bucket] ?? 0
      if (seen >= target) {
        return Math.max(0, Math.ceil(2 ** ((bucket + 1) / HISTOGRAM_SCALE) - 1))
      }
    }
    return 0
  }

  private pruneFailures(now: number): void {
    const cutoff = now - FAILURE_WINDOW_MS
    while (this.failures.length > 0 && (this.failures[0] ?? 0) < cutoff) {
      this.failures.shift()
    }
  }
}

export class HealthMonitor {
  private readonly routes = new Map<EnterpriseRoute, RouteHealth>()

  constructor(routeNames: readonly EnterpriseRoute[]) {
    for (const route of routeNames) {
      this.routes.set(route, new RouteHealth(route))
    }
  }

  canSend(route: EnterpriseRoute): boolean {
    return this.routes.get(route)?.canSend() ?? false
  }

  recordSuccess(route: EnterpriseRoute, latencyMs: number): void {
    this.routes.get(route)?.recordSuccess(latencyMs)
  }

  recordFailure(route: EnterpriseRoute): void {
    this.routes.get(route)?.recordFailure()
  }

  concurrencyScale(route: EnterpriseRoute): number {
    return this.routes.get(route)?.concurrencyScale() ?? 0
  }

  batchScale(route: EnterpriseRoute): number {
    return this.routes.get(route)?.batchScale() ?? 1
  }

  snapshot(route: EnterpriseRoute): RouteHealthSnapshot {
    const health = this.routes.get(route)
    if (!health) {
      return {
        route,
        healthState: 'UNAVAILABLE',
        circuitState: 'OPEN',
        failureCount: 0,
        avgLatencyMs: 0,
        p99LatencyMs: 0,
        nextProbeAt: null,
        lastErrorAt: null,
        lastSuccessAt: null,
      }
    }
    return health.snapshot()
  }
}
