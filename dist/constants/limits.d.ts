/**
 * Hard runtime safety bounds and safety ceilings.
 * Values returned by the control plane that exceed these bounds are invalid
 * and cause snapshot rejection. They are never silently clamped.
 */
export declare const SAFETY_CEILINGS: Readonly<{
    readonly maxSpansPerTrace: 5000;
    readonly minSpansPerTrace: 1;
    readonly maxSpanAttributes: 500;
    readonly minSpanAttributes: 1;
    readonly maxAttributeLength: number;
    readonly minAttributeLength: 1;
    readonly maxTraceDurationMs: number;
    readonly minTraceDurationMs: 1000;
    readonly maxPayloadSize: number;
    readonly minPayloadSize: 1024;
    readonly maxQueueSize: 100000;
    readonly minQueueSize: 1;
    readonly maxMemoryMb: 1024;
    readonly minMemoryMb: 1;
    readonly batchSize: 5000;
    readonly minBatchSize: 1;
    readonly flushIntervalMs: number;
    readonly minFlushIntervalMs: 0;
    readonly timeoutMs: 60000;
    readonly minTimeoutMs: 250;
    readonly retryMaxRetries: 10;
    readonly minRetryMaxRetries: 0;
    readonly retryBaseDelayMs: 30000;
    readonly minRetryBaseDelayMs: 0;
    readonly maxTotalConnections: 500;
    readonly minTotalConnections: 1;
    readonly acquireTimeoutMs: 60000;
    readonly minAcquireTimeoutMs: 100;
    readonly maxConnectionsPerRoute: 100;
    readonly minConnectionsPerRoute: 1;
    readonly maxTenantsTracked: 100000;
    readonly minTenantsTracked: 1;
    readonly quotaPerWindow: 1000000;
    readonly minQuotaPerWindow: 1;
    readonly windowDurationMs: 3600000;
    readonly minWindowDurationMs: 1000;
    readonly criticalReserve: 100000;
    readonly minCriticalReserve: 0;
    readonly maxPersistPerMinute: 1000000;
    readonly minPersistPerMinute: 1;
    readonly maxBudgetExceededLogIntervalMs: number;
    readonly minBudgetExceededLogIntervalMs: 1000;
    readonly profileMaxDurationMs: 120000;
    readonly minProfileDurationMs: 1000;
    readonly maxLogSize: 1048576;
    readonly minLogSize: 256;
    readonly stackTraceLimit: 200;
    readonly minStackTraceLimit: 1;
    readonly offlineQueueMaxFileSizeBytes: number;
    readonly offlineQueueMinFileSizeBytes: 1024;
    readonly offlineQueueMaxEvents: 100000;
    readonly offlineQueueMinEvents: 1;
    readonly offlineQueueEventTtlMs: number;
    readonly offlineQueueMinEventTtlMs: 60000;
    readonly offlineQueueIoTimeoutMs: 60000;
    readonly offlineQueueMinIoTimeoutMs: 500;
}>;
export type SafetyCeilings = typeof SAFETY_CEILINGS;
