/**
 * Cost Governor — telemetry ingestion cost control.
 *
 * Protects against:
 * - Span explosion (too many spans per trace)
 * - Metric instrument explosion
 * - Payload amplification (bytes budget)
 * - Unbounded ingestion costs
 *
 * Enterprise observability platforms charge by volume. The SDK must
 * self-govern to prevent bill shock during incidents.
 */
export interface CostGovernorOptions {
    /** Max spans allowed per trace. Default: 1000 */
    readonly maxSpansPerTrace?: number;
    /** Max active metric instruments. Default: 200 */
    readonly maxActiveInstruments?: number;
    /** Bytes budget per minute. Default: 10MB */
    readonly bytesBudgetPerMinute?: number;
    /** Enable adaptive telemetry reduction when approaching budget. Default: true */
    readonly enableAdaptiveReduction?: boolean;
}
export interface CostUtilization {
    readonly bytesPerMinute: number;
    readonly budgetUtilization: number;
    readonly activeTraces: number;
    readonly shouldReduce: boolean;
}
export interface CostStats {
    readonly totalBytesSent: number;
    readonly totalSpansBlocked: number;
    readonly totalBudgetExceeded: number;
    readonly currentBytesPerMinute: number;
    readonly budgetUtilization: number;
}
export declare class CostGovernor {
    private readonly maxSpansPerTrace;
    private readonly maxActiveInstruments;
    private readonly bytesBudgetPerMinute;
    private readonly enableAdaptiveReduction;
    private readonly traceSpanCounts;
    private readonly traceTimestamps;
    private readonly maxTrackedTraces;
    private readonly byteWindows;
    private readonly windowDurationMs;
    private totalBytesSent;
    private totalSpansBlocked;
    private totalBudgetExceeded;
    private cleanupTimer;
    constructor(options?: CostGovernorOptions);
    /**
     * Check if a new span can be created for the given trace.
     * Returns false if the trace has exceeded its span limit.
     */
    canCreateSpan(traceId: string): boolean;
    /**
     * Record bytes sent for budget tracking.
     */
    recordBytesSent(bytes: number): void;
    /**
     * Get current cost utilization.
     */
    getUtilization(): CostUtilization;
    /**
     * Should the SDK reduce telemetry volume?
     * Returns true when approaching budget limits.
     */
    shouldReduceTelemetry(): boolean;
    getStats(): CostStats;
    reset(): void;
    shutdown(): void;
    private getCurrentBytesPerMinute;
    private evictOldestTraces;
    private cleanup;
}
export declare const costGovernor: CostGovernor;
//# sourceMappingURL=cost-governor.d.ts.map