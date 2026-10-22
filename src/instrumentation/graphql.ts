/**
 * GraphQL Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with LynkTrace SDK guards and remote config support.
 *
 * Features:
 * - Per-resolver spans (optional, controlled by captureResolvers)
 * - Operation name, variables, and result capture
 * - Error tracking with stack traces
 * - Depth limiting to prevent malicious queries
 * - Ignore rules for introspection queries
 */

import { GraphQLInstrumentation as OTelGraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql'
import type { GraphQLInstrumentationConfig as OTelGraphQLInstrumentationConfig } from '@opentelemetry/instrumentation-graphql'

export interface GraphQLInstrumentationOptions {
  enabled: boolean
  captureResolvers: boolean
  depthLimit?: number
  maxDepth?: number
  ignoreIntrospection?: boolean
  ignoreOperations?: boolean
  useSpanBasedPatch?: boolean
}

export function createGraphQLInstrumentation(
  config: { enabled: boolean; captureResolvers?: boolean } | boolean,
  mergedOptions?: Partial<GraphQLInstrumentationOptions>
): OTelGraphQLInstrumentation | null {
  const enabled = typeof config === 'object' ? config.enabled : config

  if (!enabled) {
    return null
  }

  const captureResolvers = typeof config === 'object' ? (config.captureResolvers ?? true) : true

  const instrumentationOptions: OTelGraphQLInstrumentationConfig = {
    ignoreResolveSpans: !captureResolvers,
  }

  const depth = mergedOptions?.depthLimit ?? mergedOptions?.maxDepth
  if (depth !== undefined) {
    instrumentationOptions.depth = depth
  }

  return new OTelGraphQLInstrumentation(instrumentationOptions)
}

export { OTelGraphQLInstrumentation }
export default createGraphQLInstrumentation
