/**
 * GraphQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Per-resolver spans (optional, controlled by captureResolvers)
 * - Operation name, variables, and result capture
 * - Error tracking with stack traces
 * - Depth limiting to prevent malicious queries
 * - Ignore rules for introspection queries
 */
import { GraphQLInstrumentation as OTelGraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
export interface GraphQLInstrumentationOptions {
    enabled: boolean;
    captureResolvers: boolean;
    depthLimit?: number;
    maxDepth?: number;
    ignoreIntrospection?: boolean;
    ignoreOperations?: boolean;
    useSpanBasedPatch?: boolean;
}
export declare function createGraphQLInstrumentation(config: {
    enabled: boolean;
    captureResolvers?: boolean;
} | boolean, mergedOptions?: Partial<GraphQLInstrumentationOptions>): OTelGraphQLInstrumentation | null;
export { OTelGraphQLInstrumentation };
export default createGraphQLInstrumentation;
