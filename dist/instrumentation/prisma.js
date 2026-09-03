/**
 * Prisma Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, timing, and model
 * - Parameter capture (configurable via captureParams)
 * - Error tracking with query context
 * - Batch query support
 * - Transaction instrumentation
 */
import { PrismaInstrumentation as OTelPrismaInstrumentation } from '@prisma/instrumentation';
export function createPrismaInstrumentation(config, mergedOptions) {
    const enabled = typeof config === 'object' ? config.enabled : config;
    if (!enabled) {
        return null;
    }
    return new OTelPrismaInstrumentation();
}
export { OTelPrismaInstrumentation };
export default createPrismaInstrumentation;
