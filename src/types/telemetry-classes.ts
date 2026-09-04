/**
 * Telemetry Classes, Pressure States, Quota States, and Correlation Group Types.
 *
 * Enterprise Observability Architecture:
 * - Priority classes: P0 (Critical), P1 (Errors/Correlated Context), P2 (Normal), P3 (Best Effort)
 * - Pressure state machine: HEALTHY, ELEVATED, PRESSURED, CRITICAL, RECOVERING
 * - Quota state machine: QUOTA_OK, QUOTA_NEAR_LIMIT, QUOTA_EXHAUSTED, QUOTA_RESET
 * - Correlation groups: Atomic diagnostic units (request + trace + spans + errors)
 */

export type TelemetryPriority = 'p0_critical' | 'p1_error' | 'p2_request' | 'p3_low'

export type PressureState =
  | 'HEALTHY'
  | 'ELEVATED'
  | 'PRESSURED'
  | 'CRITICAL'
  | 'RECOVERING'

export type QuotaState =
  | 'QUOTA_OK'
  | 'QUOTA_NEAR_LIMIT'
  | 'QUOTA_EXHAUSTED'
  | 'QUOTA_RESET'

export interface DegradationInfo {
  readonly telemetryDegraded: boolean
  readonly pressureLevel: PressureState
  readonly samplingReason?: string | undefined
  readonly droppedSpanCount?: number | undefined
  readonly droppedEventCount?: number | undefined
}

export interface CorrelationGroupInfo {
  readonly groupId: string
  readonly traceId?: string | undefined
  readonly requestId?: string | undefined
  readonly highestPriority: TelemetryPriority
  readonly eventCount: number
  readonly hasError: boolean
  readonly hasFatal: boolean
  readonly admitted: boolean
  readonly degraded?: DegradationInfo | undefined
}

export interface OperationalMetricsSnapshot {
  readonly eventsCreated: number
  readonly eventsAdmitted: number
  readonly eventsShed: number
  readonly eventsDroppedByPriority: Record<TelemetryPriority, number>
  readonly eventsDroppedQuotaExhausted: number
  readonly batchesCreated: number
  readonly batchesSent: number
  readonly batchesFailed: number
  readonly batchesRetried: number
  readonly batchesDropped: number
  readonly quotaState: QuotaState
  readonly quotaRemaining?: number | undefined
  readonly quotaResetAt?: number | undefined
  readonly pressureState: PressureState
  readonly pressureScore: number
  readonly pressureTransitions: number
  readonly recoveryTransitions: number
  readonly correlationGroupsAdmitted: number
  readonly correlationGroupsShed: number
  readonly correlationGroupsDegraded: number
}
