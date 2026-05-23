/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards to prevent duplicate spans and
 * recursive SDK tracing.
 *
 * Provides:
 * - HTTP client instrumentation (http/https/fetch/undici)
 * - Express framework instrumentation
 * - Self-request guard (prevents tracing SDK's own ingestion calls)
 * - No duplicate spans (OTel SDK handles deduplication)
 * - Low-overhead runtime performance
 *
 * Architecture:
 *   OTel Instrumentation → Pulse SpanProcessor → PipelineSpanExporter → EventPipeline
 */
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { client } from '../core/client.js';
import { getLogger } from '../utils/logger.js';
// ─── State ──────────────────────────────────────────────────────────────────
const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered');
/**
 * Register OpenTelemetry auto-instrumentations with Pulse SDK guards.
 * Idempotent — safe to call multiple times, even across multiple SDK copies
 * in the same V8 isolate (uses Symbol.for global guard).
 */
export function registerAutoInstrumentations(options = {}) {
    const g = globalThis;
    if (g[INSTRUMENTATION_GUARD])
        return;
    g[INSTRUMENTATION_GUARD] = true;
    const logger = getLogger();
    const instrumentations = [];
    if (options.http !== false) {
        instrumentations.push(new HttpInstrumentation({
            ignoreOutgoingRequestHook: (request) => {
                if (!client.initialized)
                    return false;
                try {
                    const ingestUrl = client.config.ingestUrl;
                    if (!ingestUrl)
                        return false;
                    let url = '';
                    if (typeof request === 'string') {
                        url = request;
                    }
                    else if (request && typeof request === 'object') {
                        const req = request;
                        url = String(req.href ?? req.url ?? '');
                    }
                    if (!url)
                        return false;
                    const target = new URL(url);
                    const ingest = new URL(ingestUrl);
                    return isInternalSdkUrl(target, ingest);
                }
                catch {
                    return false;
                }
            },
            ignoreIncomingRequestHook: (request) => {
                try {
                    const req = request;
                    const url = String(req.url ?? '');
                    const path = url.split('?')[0] ?? '';
                    return ['/health', '/ready', '/healthz', '/livez', '/metrics', '/v1/events', '/v1/init'].includes(path);
                }
                catch {
                    return false;
                }
            },
        }));
    }
    if (options.express !== false) {
        instrumentations.push(new ExpressInstrumentation());
    }
    if (options.fastify !== false) {
        instrumentations.push(new FastifyInstrumentation());
    }
    if (options.undici !== false) {
        instrumentations.push(new UndiciInstrumentation({
            ignoreRequestHook: (request) => {
                if (!client.initialized)
                    return false;
                try {
                    const ingest = new URL(client.config.ingestUrl);
                    const req = request;
                    const rawOrigin = req.origin ?? req['origin'];
                    const rawPath = req.path ?? req['path'] ?? req.pathname;
                    const url = rawOrigin
                        ? new URL(String(rawPath ?? '/'), String(rawOrigin))
                        : new URL(String(req.url ?? ''));
                    return isInternalSdkUrl(url, ingest);
                }
                catch {
                    return false;
                }
            },
        }));
    }
    if (instrumentations.length === 0) {
        logger.debug('No auto-instrumentations registered');
        return;
    }
    registerInstrumentations({
        instrumentations: instrumentations,
    });
    logger.info('Auto-instrumentations registered', {
        http: options.http !== false,
        express: options.express !== false,
        fastify: options.fastify !== false,
        undici: options.undici !== false,
        count: instrumentations.length,
    });
}
/**
 * Reset auto-instrumentation state — for testing.
 * @internal
 */
export function resetAutoInstrumentations() {
    delete globalThis[INSTRUMENTATION_GUARD];
}
function isInternalSdkUrl(target, ingest) {
    if (target.origin !== ingest.origin)
        return false;
    return target.pathname === ingest.pathname
        || target.pathname === '/v1/events'
        || target.pathname === '/v1/init';
}
//# sourceMappingURL=auto-instrument.js.map