/**
 * @deprecated — REMOVED in v3.0
 *
 * The SDK-side slow request detector has been permanently removed.
 * Slow request detection is now handled entirely on the backend using
 * OTel http.server.duration latency histograms.
 *
 * Backend-side detection provides:
 * - Zero SDK CPU overhead (no timer loops, no per-route Maps)
 * - Statistical accuracy (ExponentialHistogram → true p99)
 * - Centralized threshold management (change thresholds without redeploy)
 * - Cross-service correlation (slow upstreams → downstream latency)
 * - Anomaly detection with ML (not possible SDK-side)
 *
 * How it works:
 *   OTel auto-instrumentation records http.server.duration → ExponentialHistogram
 *   → LynkTrace backend queries: WHERE percentile(http.server.duration, 0.99) > threshold
 *   → Backend triggers alerts/anomaly detection
 *
 * This file is a BACKWARD-COMPATIBLE STUB. All methods are no-ops.
 * It will be fully removed in the next major version.
 */
export interface SlowRequestOptions {
    thresholdMs?: number;
    routeThresholds?: Record<string, number>;
    enableAlerts?: boolean;
    alertSeverity?: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
    maxRoutes?: number;
}
declare class SlowRequestDetector {
    configure(_options: SlowRequestOptions): void;
    check(_options: {
        route: string;
        method: string;
        latencyMs: number;
        statusCode: number;
        requestId?: string;
        traceId?: string;
    }): boolean;
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
    reset(): void;
}
export declare const slowRequestDetector: SlowRequestDetector;
export { SlowRequestDetector };
