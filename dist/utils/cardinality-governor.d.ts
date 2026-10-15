/**
 * Cardinality Governor — enterprise protection against metric dimension explosion.
 *
 * Prevents:
 * - userId/requestId/traceId as metric labels (unbounded cardinality)
 * - Dynamic route parameters in metric labels (/users/123 → /users/:id)
 * - Query parameter leakage into labels
 * - Metric series explosion (bounded per-instrument and total)
 * - Histogram dimension explosion
 *
 * Enterprise observability platforms (Datadog, New Relic) impose cardinality
 * limits server-side. We enforce them SDK-side to prevent ingestion rejection.
 */
export interface CardinalityGovernorOptions {
    /** Max attribute keys per metric instrument. Default: 10 */
    readonly maxDimensionsPerMetric?: number;
    /** Max unique timeseries per instrument. Default: 1000 */
    readonly maxSeriesPerMetric?: number;
    /** Max total timeseries across all instruments. Default: 5000 */
    readonly maxTotalSeries?: number;
    /** Attribute names that are ALWAYS blocked as metric labels. */
    readonly blockedAttributes?: readonly string[];
    /** Enable automatic route path normalization. Default: true */
    readonly enableRouteNormalization?: boolean;
}
export interface CardinalityStats {
    readonly totalSeries: number;
    readonly blockedAttributeCount: number;
    readonly droppedSeriesCount: number;
    readonly instrumentCount: number;
}
export declare class CardinalityGovernor {
    private readonly maxDimensionsPerMetric;
    private readonly maxSeriesPerMetric;
    private readonly maxTotalSeries;
    private readonly blockedAttributes;
    private readonly enableRouteNormalization;
    private seriesTracker;
    private totalSeries;
    private blockedAttributeCount;
    private droppedSeriesCount;
    private evictionTimer;
    private static readonly EVICTION_INTERVAL_MS;
    constructor(options?: CardinalityGovernorOptions);
    /**
     * Sanitize metric attributes — removes blocked keys, normalizes routes,
     * enforces dimension limits.
     *
     * Returns a cleaned copy of the attributes. Never mutates the input.
     */
    sanitizeAttributes(metricName: string, attributes: Record<string, string>): Record<string, string>;
    /**
     * Check if recording a new series for this metric is allowed.
     * Returns false if cardinality limits would be exceeded.
     */
    canRecordSeries(metricName: string, attributeKey: string): boolean;
    /**
     * Normalize a URL path to remove dynamic segments.
     *
     * Examples:
     *   /users/123 → /users/:id
     *   /api/v1/orders/abc-def-123 → /api/v1/orders/:id
     *   /items?page=2&sort=name → /items
     */
    normalizeRoute(path: string): string;
    getStats(): CardinalityStats;
    reset(): void;
    /**
     * Start the periodic eviction timer if not currently running.
     * Safe to call multiple times.
     */
    start(): void;
    /**
     * Stop the eviction timer. Call during SDK shutdown to prevent
     * the timer from holding the process alive.
     */
    shutdown(): void;
    /**
     * Periodic eviction — evicts only series that have been idle for longer
     * than EVICTION_INTERVAL_MS (1 hour), preserving active core metric series.
     * Because Map preserves insertion/refresh order (oldest first), this runs
     * in O(1) for active entries and fast breaks as soon as a non-stale entry is hit.
     */
    private evictStaleSeries;
}
export declare const cardinalityGovernor: CardinalityGovernor;
