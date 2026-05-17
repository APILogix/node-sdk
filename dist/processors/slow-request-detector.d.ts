/**
 * Slow request detection — identifies and alerts on slow requests.
 *
 * Features:
 * - Configurable thresholds (global and per-route)
 * - Percentile-based detection (p50, p90, p95, p99)
 * - Route normalization for grouping
 * - Alert metadata attachment to slow request events
 * - Automatic metric emission for slow request counts
 * - Memory-safe bounded tracking
 */
export interface SlowRequestOptions {
    /** Global slow request threshold in ms. Default: 1000 */
    thresholdMs?: number;
    /** Per-route thresholds (route pattern -> ms). */
    routeThresholds?: Record<string, number>;
    /** Enable alert messages for slow requests. Default: true */
    enableAlerts?: boolean;
    /** Alert severity level. Default: 'warning' */
    alertSeverity?: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
    /** Max routes to track. Default: 500 */
    maxRoutes?: number;
}
declare class SlowRequestDetector {
    private thresholdMs;
    private routeThresholds;
    private routeStats;
    private enableAlerts;
    private alertSeverity;
    private maxRoutes;
    private initialized;
    private totalSlow;
    private totalChecked;
    constructor(options?: SlowRequestOptions);
    configure(options: SlowRequestOptions): void;
    /**
     * Check if a request is slow and record metrics/alerts.
     * Call this at the end of request processing.
     */
    check(options: {
        route: string;
        method: string;
        latencyMs: number;
        statusCode: number;
        requestId?: string;
        traceId?: string;
    }): boolean;
    /**
     * Get slow request statistics.
     */
    getStats(): {
        initialized: boolean;
        totalChecked: number;
        totalSlow: number;
        slowRate: number;
        trackedRoutes: number;
        topSlowRoutes: Array<{
            route: string;
            slowCount: number;
            avgMs: number;
            maxMs: number;
        }>;
    };
    /**
     * Reset all statistics.
     */
    reset(): void;
    private updateRouteStats;
    private recordSlowMetrics;
    private emitAlert;
    private parseSeverity;
}
export declare const slowRequestDetector: SlowRequestDetector;
export { SlowRequestDetector };
//# sourceMappingURL=slow-request-detector.d.ts.map