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
/**
 * Creates an OpenTelemetry query extension for Prisma Client.
 * Attach with `prismaClient.$extends(pulsePrismaExtension())`
 * or use automatic instrumentation.
 */
export declare function pulsePrismaExtension(): {
    name: string;
    query: {
        $allModels: {
            $allOperations({ model, operation, args, query }: any): Promise<any>;
        };
    };
};
/**
 * Automatically instrument a PrismaClient instance via $use middleware.
 * Ensures queries emit spans even if previewFeatures = ["tracing"] is omitted in schema.prisma.
 */
export declare function instrumentPrismaClientInstance(prismaInstance: any): void;
export declare function createPrismaInstrumentation(config: {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
} | boolean, mergedOptions?: Partial<PrismaInstrumentationOptions>): OTelPrismaInstrumentation | null;
export { OTelPrismaInstrumentation };
export default createPrismaInstrumentation;
