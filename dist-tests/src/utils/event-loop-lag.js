/**
 * Event Loop Lag Monitor — tracks Node.js event loop latency using
 * the built-in `perf_hooks.monitorEventLoopDelay` API.
 *
 * This is critical for observability: high event loop lag indicates
 * CPU saturation, blocking I/O, or GC pauses that degrade application
 * performance.
 *
 * Usage:
 *   const monitor = new EventLoopLagMonitor({ emitIntervalMs: 10_000 })
 *   monitor.start()
 *   monitor.on('lag', (stats) => captureMetric('event_loop.lag_ms', stats.p99))
 *   // ...
 *   monitor.stop()
 */
import { EventEmitter } from 'events';
import { monitorEventLoopDelay } from 'perf_hooks';
/**
 * Monitors the Node.js event loop delay using a high-resolution histogram.
 *
 * Emits:
 *   'lag' → { min, max, mean, p50, p95, p99, stddev } (all in ms)
 */
export class EventLoopLagMonitor extends EventEmitter {
    emitIntervalMs;
    resolutionNs;
    histogram = null;
    timer = null;
    constructor(options = {}) {
        super();
        this.emitIntervalMs = options.emitIntervalMs ?? 10_000;
        this.resolutionNs = options.resolutionNs ?? 20_000_000;
    }
    /** Start monitoring the event loop. */
    start() {
        if (this.histogram)
            return;
        this.histogram = monitorEventLoopDelay({ resolution: this.resolutionNs });
        this.histogram.enable();
        this.timer = setInterval(() => {
            this.emitStats();
        }, this.emitIntervalMs);
        // Don't hold the process open for monitoring
        this.timer.unref();
    }
    /** Stop monitoring and clean up. */
    stop() {
        if (this.histogram) {
            this.histogram.disable();
            this.histogram = null;
        }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Reset the histogram to clear startup/warmup outliers. */
    reset() {
        if (this.histogram) {
            this.histogram.reset();
        }
    }
    /** Get current lag stats without emitting an event. */
    getStats() {
        if (!this.histogram)
            return null;
        return this.extractHistogramStats(this.histogram);
    }
    /** Returns true if event loop lag p99 exceeds the given threshold (ms). */
    isLagging(thresholdMs) {
        const stats = this.getStats();
        if (!stats)
            return false;
        return stats.p99 > thresholdMs;
    }
    emitStats() {
        const stats = this.getStats();
        if (!stats)
            return;
        this.emit('lag', stats);
        // Reset histogram for the next interval so stats are per-window
        this.histogram?.reset();
    }
    extractHistogramStats(h) {
        return this.readHistogram(h);
    }
    readHistogram(h) {
        // IntervalHistogram reports in nanoseconds — convert to milliseconds
        const nsToMs = (ns) => Math.round((ns / 1_000_000) * 100) / 100;
        return {
            min: nsToMs(h.min),
            max: nsToMs(h.max),
            mean: nsToMs(h.mean),
            p50: nsToMs(h.percentile(50)),
            p95: nsToMs(h.percentile(95)),
            p99: nsToMs(h.percentile(99)),
            stddev: nsToMs(h.stddev),
        };
    }
}
