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
export interface PrismaInstrumentationOptions {
    enabled: boolean;
    captureQueries: boolean;
    captureParams: boolean;
}
export declare function createPrismaInstrumentation(config: {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
} | boolean, mergedOptions?: Partial<PrismaInstrumentationOptions>): OTelPrismaInstrumentation | null;
export { OTelPrismaInstrumentation };
export default createPrismaInstrumentation;
//# sourceMappingURL=prisma.d.ts.map