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
// ─── Instrumentation ────────────────────────────────────────────────────────
export { monitorMiddleware } from './instrumentation/express.js';
export { setLogger, getLogger, setDebugMode } from './utils/logger.js';
export { Severity, severityFromString } from './types/severity.js';
//# sourceMappingURL=index.js.map