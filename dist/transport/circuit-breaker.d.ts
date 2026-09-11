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
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export interface CircuitBreakerOptions {
    /** Number of consecutive failures before opening the circuit. Default: 5 */
    readonly failureThreshold?: number;
    /** Time in ms before transitioning from OPEN to HALF_OPEN. Default: 30000 */
    readonly resetTimeoutMs?: number;
    /** Number of probe requests allowed in HALF_OPEN state. Default: 1 */
    readonly halfOpenMaxProbes?: number;
}
export declare class CircuitBreaker {
    private state;
    private consecutiveFailures;
    private lastFailureTime;
    private halfOpenProbeCount;
    private readonly failureThreshold;
    private readonly resetTimeoutMs;
    private readonly halfOpenMaxProbes;
    constructor(options?: CircuitBreakerOptions);
    /**
     * Check if a request should be allowed through.
     * Returns true if the circuit allows the request.
     */
    canExecute(): boolean;
    /**
     * Record a successful request.
     * Resets failure count and transitions HALF_OPEN → CLOSED.
     */
    recordSuccess(): void;
    /**
     * Record a failed request.
     * Increments failure count and potentially opens the circuit.
     */
    recordFailure(): void;
    /** Get the current circuit state. */
    getState(): CircuitState;
    /** Get current failure count. */
    getFailureCount(): number;
    /** Force-reset the circuit to CLOSED state. */
    reset(): void;
    private transitionTo;
}
