/**
 * Prisma Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with LynkTrace SDK guards and remote config support.
 *
 * Features:
 * - Query spans with operation name, timing, and model
 * - Parameter capture (configurable via captureParams)
 * - Error tracking with query context
 * - Batch query support
 * - Transaction instrumentation
 */
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { PrismaInstrumentation as OTelPrismaInstrumentation } from '@prisma/instrumentation';
import type { TracerProvider } from '@opentelemetry/api';
export interface PrismaInstrumentationOptions {
    enabled: boolean;
    captureQueries: boolean;
    captureParams: boolean;
}
export declare function resolvePrismaDbSystem(prismaInstance: any): string;
/**
 * Creates an OpenTelemetry query extension for Prisma Client.
 * Attach with `prismaClient.$extends(lynktracePrismaExtension())`
 * or use automatic instrumentation.
 */
export declare function lynktracePrismaExtension(dbSystem?: string): {
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
export declare function instrumentPrismaClientInstance(prismaInstance: any): any;
export declare class LynkTracePrismaInstrumentation extends InstrumentationBase {
    private otelPrisma?;
    constructor(config?: {
        enabled?: boolean;
        captureQueries?: boolean;
        captureParams?: boolean;
        ignoreSpanTypes?: (string | RegExp)[];
    });
    setTracerProvider(tracerProvider: TracerProvider): void;
    protected init(): InstrumentationNodeModuleDefinition[];
    enable(): void;
    disable(): void;
}
export declare function createPrismaInstrumentation(config: {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
} | boolean, mergedOptions?: Partial<PrismaInstrumentationOptions>): LynkTracePrismaInstrumentation | null;
export { OTelPrismaInstrumentation };
export default createPrismaInstrumentation;
