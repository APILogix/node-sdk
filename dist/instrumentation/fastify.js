/**
 * Compatibility shim.
 *
 * Fastify tracing is provided by OpenTelemetry FastifyInstrumentation.
 * The legacy plugin remains export-compatible but does not create spans,
 * inject propagation headers, or capture duplicate request telemetry.
 */
import { getLogger } from '../utils/logger.js';
export function fastifyPulsePlugin(_fastify, _opts, done) {
    getLogger().info('Fastify manual plugin is a no-op; OpenTelemetry owns Fastify tracing');
    done();
}
//# sourceMappingURL=fastify.js.map