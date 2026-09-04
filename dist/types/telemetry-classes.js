/**
 * Telemetry Classes, Pressure States, Quota States, and Correlation Group Types.
 *
 * Enterprise Observability Architecture:
 * - Priority classes: P0 (Critical), P1 (Errors/Correlated Context), P2 (Normal), P3 (Best Effort)
 * - Pressure state machine: HEALTHY, ELEVATED, PRESSURED, CRITICAL, RECOVERING
 * - Quota state machine: QUOTA_OK, QUOTA_NEAR_LIMIT, QUOTA_EXHAUSTED, QUOTA_RESET
 * - Correlation groups: Atomic diagnostic units (request + trace + spans + errors)
 */
export {};
