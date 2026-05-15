/**
 * Circuit breaker — prevents cascading failures when the ingestion endpoint is down.
 *
 * States:
 *   CLOSED  → normal operation, requests flow through
 *   OPEN    → endpoint is failing, requests are blocked (events buffered, not dropped)
 *   HALF_OPEN → probing with limited requests to test recovery
 *
 * Transitions:
 *   CLOSED → OPEN: when failure count exceeds threshold within window
 *   OPEN → HALF_OPEN: after resetTimeoutMs elapses
 *   HALF_OPEN → CLOSED: if probe succeeds
 *   HALF_OPEN → OPEN: if probe fails
 */

import { getLogger } from '../utils/logger.js'

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  readonly failureThreshold?: number
  /** Time in ms before transitioning from OPEN to HALF_OPEN. Default: 30000 */
  readonly resetTimeoutMs?: number
  /** Number of probe requests allowed in HALF_OPEN state. Default: 1 */
  readonly halfOpenMaxProbes?: number
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private consecutiveFailures = 0
  private lastFailureTime = 0
  private halfOpenProbeCount = 0

  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly halfOpenMaxProbes: number

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? 1
  }

  /**
   * Check if a request should be allowed through.
   * Returns true if the circuit allows the request.
   */
  canExecute(): boolean {
    const logger = getLogger()

    switch (this.state) {
      case 'CLOSED':
        return true

      case 'OPEN': {
        // Check if it's time to probe
        if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
          this.transitionTo('HALF_OPEN')
          this.halfOpenProbeCount = 0
          logger.info('Circuit breaker transitioning to HALF_OPEN for probe')
          return true
        }
        return false
      }

      case 'HALF_OPEN':
        // Allow limited probes
        if (this.halfOpenProbeCount < this.halfOpenMaxProbes) {
          this.halfOpenProbeCount += 1
          return true
        }
        return false
    }
  }

  /**
   * Record a successful request.
   * Resets failure count and transitions HALF_OPEN → CLOSED.
   */
  recordSuccess(): void {
    const logger = getLogger()
    const previousState = this.state

    this.consecutiveFailures = 0

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('CLOSED')
      logger.info('Circuit breaker CLOSED — endpoint recovered', {
        previousState,
      })
    }
  }

  /**
   * Record a failed request.
   * Increments failure count and potentially opens the circuit.
   */
  recordFailure(): void {
    const logger = getLogger()

    this.consecutiveFailures += 1
    this.lastFailureTime = Date.now()

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN')
      logger.warn('Circuit breaker OPEN — probe failed, endpoint still down', {
        consecutiveFailures: this.consecutiveFailures,
        resetTimeoutMs: this.resetTimeoutMs,
      })
      return
    }

    if (this.state === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
      this.transitionTo('OPEN')
      logger.warn('Circuit breaker OPEN — failure threshold exceeded', {
        consecutiveFailures: this.consecutiveFailures,
        failureThreshold: this.failureThreshold,
        resetTimeoutMs: this.resetTimeoutMs,
      })
    }
  }

  /** Get the current circuit state. */
  getState(): CircuitState {
    // Auto-transition OPEN → HALF_OPEN if timeout has elapsed
    if (this.state === 'OPEN' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.transitionTo('HALF_OPEN')
      this.halfOpenProbeCount = 0
    }
    return this.state
  }

  /** Get current failure count. */
  getFailureCount(): number {
    return this.consecutiveFailures
  }

  /** Force-reset the circuit to CLOSED state. */
  reset(): void {
    this.state = 'CLOSED'
    this.consecutiveFailures = 0
    this.lastFailureTime = 0
    this.halfOpenProbeCount = 0
  }

  private transitionTo(newState: CircuitState): void {
    this.state = newState
  }
}
