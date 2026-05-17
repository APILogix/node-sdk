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
import { getLogger } from '../utils/logger.js';
import { epochMs } from '../utils/time.js';
import { incrementCounter, recordHistogram } from '../capture/captureMetric.js';
import { captureMessage } from '../capture/captureMessage.js';
import { Severity } from '../types/severity.js';
class SlowRequestDetector {
    thresholdMs;
    routeThresholds;
    routeStats;
    enableAlerts;
    alertSeverity;
    maxRoutes;
    initialized = false;
    totalSlow = 0;
    totalChecked = 0;
    constructor(options = {}) {
        this.thresholdMs = options.thresholdMs ?? 1000;
        this.routeThresholds = new Map(Object.entries(options.routeThresholds ?? {}));
        this.routeStats = new Map();
        this.enableAlerts = options.enableAlerts ?? true;
        this.alertSeverity = this.parseSeverity(options.alertSeverity ?? 'warning');
        this.maxRoutes = options.maxRoutes ?? 500;
    }
    configure(options) {
        this.thresholdMs = options.thresholdMs ?? this.thresholdMs;
        if (options.routeThresholds) {
            for (const [route, threshold] of Object.entries(options.routeThresholds)) {
                this.routeThresholds.set(route, threshold);
            }
        }
        this.enableAlerts = options.enableAlerts ?? this.enableAlerts;
        if (options.alertSeverity) {
            this.alertSeverity = this.parseSeverity(options.alertSeverity);
        }
        this.maxRoutes = options.maxRoutes ?? this.maxRoutes;
        this.initialized = true;
    }
    /**
     * Check if a request is slow and record metrics/alerts.
     * Call this at the end of request processing.
     */
    check(options) {
        if (!this.initialized)
            return false;
        this.totalChecked++;
        const threshold = this.routeThresholds.get(options.route) ?? this.thresholdMs;
        const isSlow = options.latencyMs > threshold;
        this.updateRouteStats(options.route, options.latencyMs, isSlow);
        if (isSlow) {
            this.totalSlow++;
            this.recordSlowMetrics(options, threshold);
            if (this.enableAlerts) {
                this.emitAlert(options, threshold);
            }
        }
        return isSlow;
    }
    /**
     * Get slow request statistics.
     */
    getStats() {
        const topRoutes = Array.from(this.routeStats.entries())
            .filter(([, stats]) => stats.slowCount > 0)
            .sort((a, b) => b[1].slowCount - a[1].slowCount)
            .slice(0, 10)
            .map(([route, stats]) => ({
            route,
            slowCount: stats.slowCount,
            avgMs: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
            maxMs: stats.maxMs,
        }));
        return {
            initialized: this.initialized,
            totalChecked: this.totalChecked,
            totalSlow: this.totalSlow,
            slowRate: this.totalChecked > 0 ? this.totalSlow / this.totalChecked : 0,
            trackedRoutes: this.routeStats.size,
            topSlowRoutes: topRoutes,
        };
    }
    /**
     * Reset all statistics.
     */
    reset() {
        this.routeStats.clear();
        this.totalSlow = 0;
        this.totalChecked = 0;
    }
    // ─── Internal ─────────────────────────────────────────────────────────
    updateRouteStats(route, latencyMs, isSlow) {
        if (this.routeStats.size >= this.maxRoutes && !this.routeStats.has(route)) {
            return;
        }
        const stats = this.routeStats.get(route) ?? {
            count: 0,
            totalMs: 0,
            maxMs: 0,
            slowCount: 0,
            lastSlowAt: 0,
        };
        stats.count++;
        stats.totalMs += latencyMs;
        if (latencyMs > stats.maxMs)
            stats.maxMs = latencyMs;
        if (isSlow) {
            stats.slowCount++;
            stats.lastSlowAt = epochMs();
        }
        this.routeStats.set(route, stats);
    }
    recordSlowMetrics(options, threshold) {
        incrementCounter('pulse.slow_requests', 1, {
            route: options.route,
            method: options.method,
            status_code: String(options.statusCode),
        });
        recordHistogram('pulse.slow_request.latency', options.latencyMs, {
            route: options.route,
            method: options.method,
        });
        recordHistogram('pulse.slow_request.threshold_exceeded', options.latencyMs - threshold, {
            route: options.route,
        });
    }
    emitAlert(options, threshold) {
        const logger = getLogger();
        const exceeded = options.latencyMs - threshold;
        const multiplier = (options.latencyMs / threshold).toFixed(1);
        const context = {
            route: options.route,
            method: options.method,
            latencyMs: options.latencyMs,
            thresholdMs: threshold,
            exceededMs: exceeded,
            multiplier: `${multiplier}x`,
            statusCode: options.statusCode,
            requestId: options.requestId,
            traceId: options.traceId,
            alert: {
                type: 'slow_request',
                severity: this.alertSeverity,
                message: `Slow request: ${options.method} ${options.route} took ${options.latencyMs}ms (threshold: ${threshold}ms)`,
            },
        };
        captureMessage(`Slow request detected: ${options.method} ${options.route} (${options.latencyMs}ms)`, this.alertSeverity, context);
        logger.debug('Slow request alert emitted', {
            route: options.route,
            latencyMs: options.latencyMs,
            threshold,
            exceeded,
        });
    }
    parseSeverity(level) {
        switch (level) {
            case 'debug': return Severity.Debug;
            case 'info': return Severity.Info;
            case 'warning': return Severity.Warning;
            case 'error': return Severity.Error;
            case 'fatal': return Severity.Fatal;
            default: return Severity.Warning;
        }
    }
}
export const slowRequestDetector = new SlowRequestDetector();
export { SlowRequestDetector };
//# sourceMappingURL=slow-request-detector.js.map