/**
 * Hard runtime safety bounds and safety ceilings.
 * Values returned by the control plane that exceed these bounds are invalid
 * and cause snapshot rejection. They are never silently clamped.
 */
export const SAFETY_CEILINGS = Object.freeze({
  // Spans & Tracing limits
  maxSpansPerTrace: 5_000,
  minSpansPerTrace: 1,
  maxSpanAttributes: 500,
  minSpanAttributes: 1,
  maxAttributeLength: 16 * 1024, // 16 KB
  minAttributeLength: 1,
  maxTraceDurationMs: 30 * 60 * 1_000, // 30 minutes
  minTraceDurationMs: 1_000, // 1 second

  // Payload & Memory limits
  maxPayloadSize: 4 * 1024 * 1024, // 4 MB
  minPayloadSize: 1_024, // 1 KB
  maxQueueSize: 100_000,
  minQueueSize: 1,
  maxMemoryMb: 1_024, // 1 GB
  minMemoryMb: 1, // 1 MB

  // Transport & Batching limits
  batchSize: 5_000,
  minBatchSize: 1,
  flushIntervalMs: 5 * 60 * 1_000, // 5 minutes
  minFlushIntervalMs: 0, // 0 = immediate
  timeoutMs: 60_000, // 60 seconds
  minTimeoutMs: 250, // 250 ms
  retryMaxRetries: 10,
  minRetryMaxRetries: 0,
  retryBaseDelayMs: 30_000, // 30 seconds
  minRetryBaseDelayMs: 0,

  // Connections & Sockets
  maxTotalConnections: 500,
  minTotalConnections: 1,
  acquireTimeoutMs: 60_000, // 60 seconds
  minAcquireTimeoutMs: 100, // 100 ms
  maxConnectionsPerRoute: 100,
  minConnectionsPerRoute: 1,

  // Tenant Governance
  maxTenantsTracked: 100_000,
  minTenantsTracked: 1,
  quotaPerWindow: 1_000_000,
  minQuotaPerWindow: 1,
  windowDurationMs: 3_600_000, // 1 hour
  minWindowDurationMs: 1_000, // 1 second
  criticalReserve: 100_000,
  minCriticalReserve: 0,

  // Persistence Governance
  maxPersistPerMinute: 1_000_000,
  minPersistPerMinute: 1,
  maxBudgetExceededLogIntervalMs: 10 * 60 * 1_000, // 10 minutes
  minBudgetExceededLogIntervalMs: 1_000, // 1 second

  // Subsystem Safety Bounds
  profileMaxDurationMs: 120_000, // 2 minutes
  minProfileDurationMs: 1_000,
  replayMaxDurationMs: 14_400_000, // 4 hours
  minReplayDurationMs: 1_000,
  maxLogSize: 1_048_576, // 1 MB
  minLogSize: 256,
  stackTraceLimit: 200,
  minStackTraceLimit: 1,

  // Offline Storage Safety Bounds
  offlineQueueMaxFileSizeBytes: 100 * 1024 * 1024, // 100 MB
  offlineQueueMinFileSizeBytes: 1_024,
  offlineQueueMaxEvents: 100_000,
  offlineQueueMinEvents: 1,
  offlineQueueEventTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  offlineQueueMinEventTtlMs: 60_000, // 1 minute
  offlineQueueIoTimeoutMs: 60_000, // 60 seconds
  offlineQueueMinIoTimeoutMs: 500,
} as const)

export type SafetyCeilings = typeof SAFETY_CEILINGS
