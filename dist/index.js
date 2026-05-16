/**
 * @vikasbaplawat1/pulse-sdk — Enterprise Observability SDK
 *
 * Public API surface. Every export here is part of the SDK contract.
 *
 * Usage:
 *   import { createSDK, captureError, captureMessage } from '@vikasbaplawat1/pulse-sdk'
 *
 *   const sdk = await createSDK({
 *     apiKey: process.env.PULSE_API_KEY,
 *     service: 'payments-service',
 *     environment: 'production',
 *     debug: true,
 *   })
 */
// ─── Core ───────────────────────────────────────────────────────────────────
export { init } from './core/init.js';
export { flush, shutdown } from './core/lifecycle.js';
export { getConfig } from './core/config.js';
export { SDKError } from './core/errors.js';
// ─── Ergonomic Entry Point ──────────────────────────────────────────────────
import { init } from './core/init.js';
/**
 * Create and initialize the SDK — the recommended entry point.
 * Alias for `init()` with a more intuitive name.
 *
 * @example
 * ```ts
 * const sdk = await createSDK({
 *   apiKey: 'pk_live_...',
 *   service: 'payments-service',
 *   environment: 'production',
 *   debug: true,
 *   plugins: [myPlugin()],
 * })
 * ```
 */
export async function createSDK(options) {
    return init(options);
}
// ─── Capture ────────────────────────────────────────────────────────────────
export { captureError } from './capture/captureError.js';
export { captureRequest } from './capture/captureRequest.js';
export { captureMessage } from './capture/captureMessage.js';
export { captureEvent } from './capture/captureEvent.js';
export { captureMetric, incrementCounter, setGauge, recordHistogram } from './capture/captureMetric.js';
// ─── Context ────────────────────────────────────────────────────────────────
export { addBreadcrumb, getRequestContext, getTraceId, getSpanId } from './core/context.js';
// ─── Tracing ────────────────────────────────────────────────────────────────
export { startSpan, withSpan, withSpanSync, getActiveSpan, flushTracer } from './tracing/tracer.js';
export { extractTraceContext, injectTraceContext, parseTraceparent, createTraceparent } from './tracing/context-propagation.js';
export { PulseSpan } from './tracing/span.js';
// ─── Session ────────────────────────────────────────────────────────────────
export { getSessionManager } from './session/session-manager.js';
// ─── Instrumentation ────────────────────────────────────────────────────────
export { monitorMiddleware } from './instrumentation/express.js';
export { instrumentHttpClient } from './instrumentation/http.js';
export { setLogger, getLogger, setDebugMode, setLogLevel } from './utils/logger.js';
export { Severity, severityFromString } from './types/severity.js';
// ─── Plan Gating ────────────────────────────────────────────────────────────
export { getPlanDefaults, isFeatureAllowed } from './core/plan-gate.js';
// ─── Diagnostics ────────────────────────────────────────────────────────────
import { getCircuitState } from './transport/batcher.js';
import { eventQueue } from './transport/queue.js';
import { getSessionManager } from './session/session-manager.js';
import { MemoryPressureMonitor } from './utils/backpressure.js';
import { client } from './core/client.js';
/**
 * Get a comprehensive SDK health snapshot for operational dashboards.
 * Safe to call at any time — returns degraded info if SDK isn't initialized.
 */
export function getSDKHealth() {
    const monitor = new MemoryPressureMonitor();
    const memState = monitor.getState();
    const sessionMgr = getSessionManager();
    const sessionHealth = sessionMgr.getSessionHealth();
    return {
        initialized: client.initialized,
        circuitState: getCircuitState(),
        queueSize: eventQueue.size(),
        queueDropped: eventQueue.getDroppedCount(),
        queueDeadLetter: eventQueue.getDeadLetterCount(),
        memory: {
            level: memState.level,
            heapUsedMb: Math.round(memState.heapUsedMb * 100) / 100,
            heapUtilization: Math.round(memState.heapUtilization * 1000) / 1000,
        },
        session: {
            totalSessions: sessionHealth.totalSessions,
            crashFreeRate: sessionHealth.crashFreeRate,
            currentSessionId: sessionHealth.currentSessionId,
        },
        pluginCount: client.initialized ? client.plugins.length : 0,
    };
}
//# sourceMappingURL=index.js.map