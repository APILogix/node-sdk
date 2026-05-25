/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards, driven by remote config.
 *
 * Reads from ConfigManager.getConfig().instrumentation to decide
 * which modules to patch. Never monkey-patches a module if its
 * remote config flag is false.
 *
 * Lifecycle guarantees:
 * - Idempotent registration via a global symbol guard (safe across multiple
 *   imports of the SDK in the same process — common in monorepos).
 * - Full reset on shutdown: the guard symbol is cleared AND every
 *   instrumentation that exposes a teardown is invoked. This ensures the
 *   next init() rebuilds instrumentation from scratch.
 *
 * Architecture:
 *   OTel Instrumentation → Pulse SpanProcessor → PipelineSpanExporter → EventPipeline
 */

import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql'
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb'
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis-4'
import { PrismaInstrumentation } from '@prisma/instrumentation'
import { BullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq'
import { client } from '../core/client.js'
import { getLogger } from '../utils/logger.js'
import { ConfigManager } from '../core/config-manager.js'
import type { InstrumentationConfig } from '../types/config.js'
import { DEFAULT_TRACE_CAPTURE } from '../constants/internal-defaults.js'
import { createAxiosInstrumentation } from './axios.js'

// ─── Global Guard + Teardown Registry ───────────────────────────────────────
// We attach to globalThis (via Symbol.for) so the guard survives multiple
// independent imports of the SDK in the same process. Without this, a host
// app that depends on two copies of the SDK (e.g., via different transitive
// dependency paths) would patch http twice.

const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered')
const TEARDOWN_REGISTRY = Symbol.for('pulse-sdk.auto-instrumentation.teardowns')
const UNREGISTER_FN = Symbol.for('pulse-sdk.auto-instrumentation.unregister')

interface InstrumentationGlobalState {
  [INSTRUMENTATION_GUARD]?: boolean
  [TEARDOWN_REGISTRY]?: Array<() => void | Promise<void>>
  [UNREGISTER_FN]?: () => void
}

function getGlobalState(): InstrumentationGlobalState {
  return globalThis as typeof globalThis & InstrumentationGlobalState
}

// ─── Public Types ───────────────────────────────────────────────────────────

export interface AutoInstrumentOptions {
  http?: boolean
  express?: boolean
  fastify?: boolean
  undici?: boolean
  graphql?: boolean
  prisma?: boolean
  mongodb?: boolean
  redis?: boolean
  bullmq?: boolean
  axios?: boolean
}

interface ResolvedInstrumentation {
  http: boolean
  https: boolean
  express: boolean
  fastify: boolean
  undici: boolean
  graphql: boolean
  graphqlConfig: { enabled: boolean; captureResolvers: boolean }
  prisma: boolean
  prismaConfig: { enabled: boolean; captureQueries: boolean; captureParams: boolean }
  mongodb: boolean
  redis: boolean
  bullmq: boolean
  axios: boolean
  fastifyConfig: { captureHooks: boolean; captureValidationErrors: boolean }
  ignoredRoutes: string[]
  ignoredMethods: string[]
  captureConfig: TraceCaptureConfig
}

interface TraceCaptureConfig {
  headers: boolean
  body: boolean
  response: boolean
  query: boolean
  cookies: boolean
}

function resolveInstrumentationOptions(userOptions: AutoInstrumentOptions): ResolvedInstrumentation {
  const configManager = ConfigManager.getInstance()
  const config = configManager.getConfig()
  const instr: InstrumentationConfig = config.instrumentation

  // The wire schema dropped the `tracing.ignoredRoutes` / `tracing.ignoredMethods`
  // arrays — those concerns are now expressed via `sampling.routes["/path"]`
  // with all rates set to zero. Auto-instrumentation no longer applies its
  // own filtering; the sampling engine is the single source of truth.
  // `capture.*` flags come from `privacy.capture` (decision: capture pre-scrub),
  // falling back to SDK-internal defaults when remote config hasn't loaded.
  const captureConfig = config.privacy?.capture ?? DEFAULT_TRACE_CAPTURE

  const httpEnabled = instr.http ?? userOptions.http ?? true
  const httpsEnabled = instr.https ?? true

  const expressEnabled = typeof instr.express === 'object'
    ? instr.express.enabled
    : (instr.express ?? userOptions.express ?? true)

  const fastifyConfig = typeof instr.fastify === 'object'
    ? instr.fastify
    : { enabled: instr.fastify ?? userOptions.fastify ?? true, captureHooks: true, captureValidationErrors: true }

  const fetchEnabled = instr.fetch ?? userOptions.undici ?? true

  const graphqlEnabled = typeof instr.graphql === 'object'
    ? instr.graphql.enabled
    : (instr.graphql ?? userOptions.graphql ?? false)

  const graphqlConfig = typeof instr.graphql === 'object'
    ? { enabled: graphqlEnabled, captureResolvers: instr.graphql.captureResolvers ?? true }
    : { enabled: graphqlEnabled, captureResolvers: true }

  const prismaEnabled = typeof instr.prisma === 'object'
    ? instr.prisma.enabled
    : (instr.prisma ?? userOptions.prisma ?? false)

  const prismaConfig = typeof instr.prisma === 'object'
    ? { enabled: prismaEnabled, captureQueries: instr.prisma.captureQueries ?? true, captureParams: instr.prisma.captureParams ?? false }
    : { enabled: prismaEnabled, captureQueries: true, captureParams: false }

  const mongodbEnabled = instr.mongodb ?? userOptions.mongodb ?? false
  const redisEnabled = instr.redis ?? userOptions.redis ?? false
  const bullmqEnabled = instr.bullmq ?? userOptions.bullmq ?? false
  const axiosEnabled = instr.axios ?? userOptions.axios ?? false

  return {
    http: httpEnabled && httpsEnabled,
    https: httpsEnabled,
    express: expressEnabled,
    fastify: fastifyConfig.enabled,
    undici: fetchEnabled,
    graphql: graphqlConfig.enabled,
    graphqlConfig,
    prisma: prismaConfig.enabled,
    prismaConfig,
    mongodb: mongodbEnabled,
    redis: redisEnabled,
    bullmq: bullmqEnabled,
    axios: axiosEnabled,
    fastifyConfig: {
      captureHooks: fastifyConfig.captureHooks ?? true,
      captureValidationErrors: fastifyConfig.captureValidationErrors ?? true,
    },
    // Empty arrays — route/method filtering is sampling-engine territory now.
    // We still honour them in the OTel `ignoreIncomingRequestHook` below for
    // any user-provided list, but they're not populated from remote config.
    ignoredRoutes: [],
    ignoredMethods: [],
    captureConfig,
  }
}

/**
 * Register all configured auto-instrumentations.
 * Idempotent: a second call without an intervening reset is a no-op.
 */
export function registerAutoInstrumentations(options: AutoInstrumentOptions = {}): void {
  const g = getGlobalState()
  if (g[INSTRUMENTATION_GUARD]) return
  g[INSTRUMENTATION_GUARD] = true
  g[TEARDOWN_REGISTRY] = []

  const logger = getLogger()
  const resolved = resolveInstrumentationOptions(options)
  const instrumentations: unknown[] = []

  if (resolved.http) {
    instrumentations.push(
      new HttpInstrumentation({
        ignoreOutgoingRequestHook: (request: unknown) => {
          if (!client.initialized) return false
          try {
            const ingestUrl = client.config.ingestUrl
            if (!ingestUrl) return false

            let url = ''
            if (typeof request === 'string') {
              url = request
            } else if (request && typeof request === 'object') {
              const req = request as Record<string, unknown>
              url = String(req.href ?? req.url ?? '')
            }
            if (!url) return false

            const target = new URL(url)
            const ingest = new URL(ingestUrl)
            return isInternalSdkUrl(target, ingest)
          } catch {
            return false
          }
        },
        ignoreIncomingRequestHook: (request: unknown) => {
          try {
            const req = request as Record<string, unknown>
            const url = String(req.url ?? '')
            const path = url.split('?')[0] ?? ''

            if (resolved.ignoredRoutes.some(r => path === r || path.startsWith(r))) {
              return true
            }

            const method = String(req.method ?? '').toUpperCase()
            if (resolved.ignoredMethods.includes(method)) {
              return true
            }

            const SDK_INGEST_PATHS = new Set([
              '/v1/events', '/v1/init', '/v1/sdk-config',
              '/v1/traces', '/v1/requests', '/v1/errors',
              '/v1/metrics', '/v1/logs', '/v1/profiles',
              '/v1/checkins', '/v1/replays',
            ])
            return SDK_INGEST_PATHS.has(path)
          } catch {
            return false
          }
        },
      })
    )
  }

  if (resolved.express) {
    instrumentations.push(new ExpressInstrumentation())
  }

  if (resolved.fastify) {
    instrumentations.push(new FastifyInstrumentation())
  }

  if (resolved.undici) {
    instrumentations.push(
      new UndiciInstrumentation({
        ignoreRequestHook: (request: unknown) => {
          if (!client.initialized) return false
          try {
            const ingest = new URL(client.config.ingestUrl)
            const req = request as Record<string, unknown>
            const rawOrigin = req.origin ?? req['origin']
            const rawPath = req.path ?? req['path'] ?? req.pathname
            const url = rawOrigin
              ? new URL(String(rawPath ?? '/'), String(rawOrigin))
              : new URL(String(req.url ?? ''))
            return isInternalSdkUrl(url, ingest)
          } catch {
            return false
          }
        },
      })
    )
  }

  if (resolved.graphql) {
    instrumentations.push(
      new GraphQLInstrumentation({
        enabled: true,
        ignoreResolveSpans: !resolved.graphqlConfig.captureResolvers,
      })
    )
  }

  if (resolved.prisma) {
    instrumentations.push(
      new PrismaInstrumentation({
        enabled: true,
      })
    )
  }

  if (resolved.mongodb) {
    instrumentations.push(
      new MongoDBInstrumentation({
        enabled: true,
        enhancedDatabaseReporting: resolved.captureConfig.body,
      })
    )
  }

  if (resolved.redis) {
    instrumentations.push(
      new RedisInstrumentation({
        enabled: true,
        dbStatementSerializer: (cmdName, cmdArgs) => {
          const sensitiveCommands = ['AUTH', 'CONFIG SET', 'CONFIG GET', 'DEL', 'EXPIRE', 'EXPIREAT', 'GET', 'SET', 'HSET', 'HGET', 'HGETALL']
          if (sensitiveCommands.includes(cmdName.toUpperCase())) {
            return `${cmdName} [REDACTED]`
          }
          if (!resolved.captureConfig.body) {
            return cmdName
          }
          return `${cmdName} ${cmdArgs.join(' ')}`
        },
      })
    )
  }

  if (resolved.bullmq) {
    instrumentations.push(
      new BullMQInstrumentation({
        enabled: true,
      })
    )
  }

  if (resolved.axios) {
    const axiosInstrumentation = createAxiosInstrumentation(true, {
      captureRequestData: resolved.captureConfig.body,
      captureResponseData: resolved.captureConfig.response,
    }, resolved.captureConfig)
    if (axiosInstrumentation) {
      // Track teardown so reset() can fully unwind the patch.
      g[TEARDOWN_REGISTRY]!.push(axiosInstrumentation.teardown)
      // setup() is async (ESM-safe module loading) — fire-and-forget but
      // surface any failure so we can detect setup races.
      void axiosInstrumentation.setup().catch((err: unknown) => {
        logger.warn('Axios instrumentation setup failed', { error: String(err) })
      })
    }
  }

  const registeredInstrumentations = instrumentations.filter(Boolean)

  if (registeredInstrumentations.length > 0) {
    // Each call to registerInstrumentations returns an unregister function
    // that disables every instrumentation it registered. Capturing it lets
    // resetAutoInstrumentations() fully unwind monkey-patches on the next
    // shutdown — without this, the next init() would skip OTel registration
    // because the guard symbol was cleared but the patches remained live.
    const unregister = registerInstrumentations({
      instrumentations: registeredInstrumentations as any[],
    })
    g[UNREGISTER_FN] = unregister
  }

  logger.info('Auto-instrumentations registered (remote-config-driven)', {
    http: resolved.http,
    https: resolved.https,
    express: resolved.express,
    fastify: resolved.fastify,
    undici: resolved.undici,
    graphql: resolved.graphql,
    prisma: resolved.prisma,
    mongodb: resolved.mongodb,
    redis: resolved.redis,
    bullmq: resolved.bullmq,
    axios: resolved.axios,
    fastifyCaptureHooks: resolved.fastifyConfig.captureHooks,
    fastifyCaptureValidationErrors: resolved.fastifyConfig.captureValidationErrors,
    graphqlCaptureResolvers: resolved.graphqlConfig.captureResolvers,
    prismaCaptureQueries: resolved.prismaConfig.captureQueries,
    prismaCaptureParams: resolved.prismaConfig.captureParams,
    ignoredRoutes: resolved.ignoredRoutes,
    ignoredMethods: resolved.ignoredMethods,
    count: registeredInstrumentations.length,
  })
}

/**
 * Fully reset auto-instrumentation state.
 *
 * Steps:
 *   1. Run registered teardown callbacks (e.g., axios unwrap).
 *   2. Call the OTel unregister handle to disable every instrumentation.
 *   3. Clear the global guard so the next register call rebuilds from scratch.
 *
 * Errors in any single teardown are logged but never thrown — reset must
 * always succeed so a failed instrumentation cannot block SDK reinit.
 */
export function resetAutoInstrumentations(): void {
  const g = getGlobalState()
  const logger = getLogger()

  const teardowns = g[TEARDOWN_REGISTRY] ?? []
  for (const teardown of teardowns) {
    try {
      const result = teardown()
      // Tolerate async teardowns; we don't await here because reset must be
      // synchronous to integrate with the unconditional shutdown phase.
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        ;(result as Promise<unknown>).catch(err => {
          logger.warn('Auto-instrumentation teardown rejected', { error: err })
        })
      }
    } catch (err) {
      logger.warn('Auto-instrumentation teardown threw', { error: err })
    }
  }

  const unregister = g[UNREGISTER_FN]
  if (typeof unregister === 'function') {
    try {
      unregister()
    } catch (err) {
      logger.warn('Auto-instrumentation unregister threw', { error: err })
    }
  }

  delete g[INSTRUMENTATION_GUARD]
  delete g[TEARDOWN_REGISTRY]
  delete g[UNREGISTER_FN]
}

function isInternalSdkUrl(target: URL, ingest: URL): boolean {
  if (target.origin !== ingest.origin) return false
  // Every per-event-type route the v3 transport ships to. Any path the
  // SDK posts to must be listed here, otherwise the OTel HttpInstrumentation
  // creates a span for our own batch send → that span exports → the export
  // hits another route → that creates another span → infinite fan-out.
  return target.pathname === ingest.pathname
    || target.pathname === '/v1/events'
    || target.pathname === '/v1/init'
    || target.pathname === '/v1/sdk-config'
    || target.pathname === '/v1/traces'
    || target.pathname === '/v1/requests'
    || target.pathname === '/v1/errors'
    || target.pathname === '/v1/metrics'
    || target.pathname === '/v1/logs'
    || target.pathname === '/v1/profiles'
    || target.pathname === '/v1/checkins'
    || target.pathname === '/v1/replays'
}

export { GraphQLInstrumentation, MongoDBInstrumentation, RedisInstrumentation, PrismaInstrumentation, BullMQInstrumentation }
