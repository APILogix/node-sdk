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

import { context, SpanKind } from '@opentelemetry/api'
import { getTraceAggregator } from '../tracing/trace-aggregator.js'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { FastifyOtelInstrumentation } from '@fastify/otel'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql'
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb'
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis'
import { PrismaInstrumentation } from '@prisma/instrumentation'
import { BullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq'
import { client } from '../core/client.js'
import { getLogger } from '../utils/logger.js'
import { ConfigManager } from '../core/config-manager.js'
import { EntitlementGate } from '../core/entitlement-gate.js'
import type { InstrumentationConfig } from '../types/config.js'
import { createAxiosInstrumentation, SUPPRESS_INNER_HTTP } from './axios.js'
import { createPgInstrumentation } from './pg.js'
import { createMySQLInstrumentation } from './mysql.js'
import { createMongoDBInstrumentation } from './mongodb.js'
import { createRedisInstrumentation, createIORedisInstrumentation } from './redis.js'
import { createBullMQInstrumentation } from './bullmq.js'
import { createGraphQLInstrumentation } from './graphql.js'
import { createPrismaInstrumentation } from './prisma.js'
import { patchEventEmitter, unpatchEventEmitter } from './event-emitter-patch.js'
import { installHttpLifecycleGuard, uninstallHttpLifecycleGuard } from './http-lifecycle-guard.js'
import { registerEsmLoaderHooks } from './esm-loader.js'

// ─── Global Guard + Teardown Registry ───────────────────────────────────────
// We attach to globalThis (via Symbol.for) so the guard survives multiple
// independent imports of the SDK in the same process. Without this, a host
// app that depends on two copies of the SDK (e.g., via different transitive
// dependency paths) would patch http twice.

const INSTRUMENTATION_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.registered')
const TEARDOWN_REGISTRY = Symbol.for('pulse-sdk.auto-instrumentation.teardowns')
const UNREGISTER_FN = Symbol.for('pulse-sdk.auto-instrumentation.unregister')
const BOOTSTRAP_GUARD = Symbol.for('pulse-sdk.auto-instrumentation.bootstrap')

interface InstrumentationGlobalState {
  [INSTRUMENTATION_GUARD]?: boolean
  [TEARDOWN_REGISTRY]?: Array<() => void | Promise<void>>
  [UNREGISTER_FN]?: () => void
  [BOOTSTRAP_GUARD]?: boolean
}

function getGlobalState(): InstrumentationGlobalState {
  return globalThis as typeof globalThis & InstrumentationGlobalState
}

let pendingAsyncSetup: Promise<void> | null = null

/**
 * Wait for any asynchronous instrumentation setup (such as Axios ESM loader)
 * to complete before application code executes.
 */
export async function waitForPendingInstrumentations(): Promise<void> {
  if (pendingAsyncSetup) {
    try {
      await pendingAsyncSetup
    } catch {}
  }
}

// ─── Public Types ───────────────────────────────────────────────────────────

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
  redisConfig: { enabled: boolean; keyPolicy?: 'command-only' | 'sanitized-key' | 'full' | 'hash' }
  bullmq: boolean
  bullmqConfig: {
    enabled: boolean
    emitCreateSpansForBulk: boolean
    emitCreateSpansForFlow: boolean
    requireParentSpanForPublish: boolean
  }
  axios: boolean
  pg: boolean
  pgConfig: { enabled: boolean; captureQueries: boolean; captureParams: boolean }
  mysql2: boolean
  mysql2Config: { enabled: boolean; captureQueries: boolean }
  eventEmitterPatch: boolean
  fastifyConfig: { captureHooks: boolean; captureValidationErrors: boolean }
  captureConfig: TraceCaptureConfig
}

interface TraceCaptureConfig {
  headers: boolean
  body: boolean
  response: boolean
  query: boolean
  cookies: boolean
}

function resolveInstrumentationOptions(): ResolvedInstrumentation {
  const configManager = ConfigManager.getInstance()
  const config = configManager.getConfig()
  const instr: InstrumentationConfig = config.instrumentation

  const captureConfig = config.privacy.capture

  const httpEnabled = instr.http
  const httpsEnabled = instr.https

  const expressEnabled = typeof instr.express === 'object'
    ? instr.express.enabled
    : instr.express

  const fastifyConfig = typeof instr.fastify === 'object'
    ? instr.fastify
    : { enabled: instr.fastify, captureHooks: true, captureValidationErrors: true }

  const fetchEnabled = instr.fetch

  const graphqlEnabled = typeof instr.graphql === 'object'
    ? instr.graphql.enabled
    : instr.graphql

  const graphqlConfig = typeof instr.graphql === 'object'
    ? { enabled: graphqlEnabled, captureResolvers: instr.graphql.captureResolvers }
    : { enabled: graphqlEnabled, captureResolvers: true }

  const prismaEnabled = typeof instr.prisma === 'object'
    ? instr.prisma.enabled
    : instr.prisma

  const prismaConfig = typeof instr.prisma === 'object'
    ? { enabled: prismaEnabled, captureQueries: instr.prisma.captureQueries, captureParams: instr.prisma.captureParams }
    : { enabled: prismaEnabled, captureQueries: true, captureParams: false }

  const mongodbEnabled = instr.mongodb
  const redisEnabled = typeof instr.redis === 'object' ? instr.redis.enabled : Boolean(instr.redis)
  const redisConfig = typeof instr.redis === 'object'
    ? instr.redis
    : { enabled: redisEnabled, keyPolicy: 'sanitized-key' as const }
  const axiosEnabled = instr.axios

  // BullMQ accepts an object form in remote config so the control plane can
  // tune span verbosity without a redeploy. Boolean form = enabled with
  // library defaults.
  const bullmqEnabled = typeof instr.bullmq === 'object'
    ? instr.bullmq.enabled
    : instr.bullmq

  const bullmqRemote = typeof instr.bullmq === 'object' ? instr.bullmq : undefined
  const bullmqConfig = {
    enabled: bullmqEnabled,
    emitCreateSpansForBulk: bullmqRemote?.emitCreateSpansForBulk ?? true,
    emitCreateSpansForFlow: bullmqRemote?.emitCreateSpansForFlow ?? true,
    requireParentSpanForPublish: bullmqRemote?.requireParentSpanForPublish ?? false,
  }

  const pgEnabled = typeof instr.pg === 'object' ? instr.pg.enabled : instr.pg
  const pgConfig = typeof instr.pg === 'object'
    ? {
        enabled: pgEnabled,
        captureQueries: instr.pg.captureQueries,
        captureParams: instr.pg.captureParams,
      }
    : { enabled: pgEnabled, captureQueries: false, captureParams: false }

  const mysql2Enabled = typeof instr.mysql2 === 'object' ? instr.mysql2.enabled : instr.mysql2
  const mysql2Config = typeof instr.mysql2 === 'object'
    ? { enabled: mysql2Enabled, captureQueries: instr.mysql2.captureQueries }
    : { enabled: mysql2Enabled, captureQueries: false }

  const eventEmitterPatchEnabled = instr.eventEmitterPatch
  const automaticTracingAllowed = EntitlementGate.isAllowed('tracing')
  const contextBindingAllowed = automaticTracingAllowed || EntitlementGate.isAllowed('customSpans')

  return {
    http: httpEnabled && automaticTracingAllowed,
    https: httpsEnabled && automaticTracingAllowed,
    express: expressEnabled && automaticTracingAllowed,
    fastify: fastifyConfig.enabled && automaticTracingAllowed,
    undici: fetchEnabled && automaticTracingAllowed,
    graphql: graphqlConfig.enabled && automaticTracingAllowed,
    graphqlConfig,
    prisma: prismaConfig.enabled && automaticTracingAllowed,
    prismaConfig,
    mongodb: mongodbEnabled && automaticTracingAllowed,
    redis: redisEnabled && automaticTracingAllowed,
    redisConfig,
    bullmq: bullmqConfig.enabled && automaticTracingAllowed,
    bullmqConfig,
    axios: axiosEnabled && automaticTracingAllowed,
    pg: pgConfig.enabled && automaticTracingAllowed,
    pgConfig,
    mysql2: mysql2Config.enabled && automaticTracingAllowed,
    mysql2Config,
    eventEmitterPatch: eventEmitterPatchEnabled && contextBindingAllowed,
    fastifyConfig: {
      captureHooks: fastifyConfig.captureHooks,
      captureValidationErrors: fastifyConfig.captureValidationErrors,
    },
    captureConfig,
  }
}

/**
 * Register all configured auto-instrumentations.
 * Idempotent: a second call without an intervening reset is a no-op.
 */
export function registerAutoInstrumentations(): void {
  const g = getGlobalState()
  if (g[INSTRUMENTATION_GUARD] && !g[BOOTSTRAP_GUARD]) return
  if (g[BOOTSTRAP_GUARD]) resetAutoInstrumentations()
  g[INSTRUMENTATION_GUARD] = true
  delete g[BOOTSTRAP_GUARD]
  g[TEARDOWN_REGISTRY] = []

  // Ensure Node.js ESM customization hooks are registered so ESM modules are intercepted
  registerEsmLoaderHooks()

  const logger = getLogger()
  const resolved = resolveInstrumentationOptions()
  const instrumentations: unknown[] = []

  if (resolved.http || resolved.https) {
    instrumentations.push(
      new HttpInstrumentation({
        ignoreOutgoingRequestHook: (request: unknown) => {
          if (context.active().getValue(SUPPRESS_INNER_HTTP) === true) return true
          if (!client.initialized) return false
          try {
            if (!isRequestProtocolEnabled(request, resolved.http, resolved.https)) return true
            const reqCheck = request as { getHeader?: (name: string) => string | number | string[] | undefined, headers?: Record<string, string | string[]> }
            if (typeof reqCheck.getHeader === 'function' && reqCheck.getHeader('x-pulse-internal') === '1') {
              return true
            }
            if (reqCheck.headers && reqCheck.headers['x-pulse-internal'] === '1') {
              return true
            }

            const routes = ConfigManager.getInstance().getConfig().transport.routes

            let target: URL | null = null
            if (typeof request === 'string') {
              try { target = new URL(request) } catch {}
            } else if (request && typeof request === 'object') {
              const req = request as Record<string, unknown>
              const candidate = String(req.href ?? req.url ?? '')
              if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
                try { target = new URL(candidate) } catch {}
              } else {
                const host = String(req.host ?? req.hostname ?? 'localhost')
                const protocol = String(req.protocol ?? 'http:')
                const path = String(req.path ?? req.pathname ?? '/')
                try { target = new URL(`${protocol.endsWith(':') ? protocol : protocol + ':'}//${host}${path}`) } catch {}
              }
            }
            if (!target) return false

            return Object.values(routes).some(route => isInternalSdkUrl(target!, new URL(route.url)))
          } catch {
            return false
          }
        },
        ignoreIncomingRequestHook: (request: unknown) =>
          !isRequestProtocolEnabled(request, resolved.http, resolved.https),

        // ─── Defensive Lifecycle Hooks ───────────────────────────────
        // Guard against the socket destruction race condition in OTel's
        // HTTP instrumentation. These hooks fire inside OTel's
        // safeExecuteInTheMiddle so exceptions are caught — but more
        // importantly they ensure the span gets diagnostic attributes
        // when the socket is in a degraded state, preventing the
        // downstream utils from crashing on null properties.

        requestHook: (span, request) => {
          try {
            const req = request as unknown as Record<string, unknown>
            ;(req as any).__pulseServerSpan = span
            const socket = req.socket as Record<string, unknown> | null | undefined
            if (socket && (socket.destroyed === true || socket.writable === false)) {
              span.setAttribute('pulse.http.socket_state', 'destroyed')
            }

            // P0.3: Root HTTP Server Span Lifecycle Coordination
            // Ensure root HTTP server span remains open until all request-scoped async operations
            // (database queries, external calls, async route handler continuation) complete.
            const spanAny = span as unknown as Record<string, unknown>
            const isServerSpan = spanAny['kind'] === SpanKind.SERVER || (!('getHeader' in (request as any)) && 'socket' in (request as any))
            if (isServerSpan && typeof (span as any).end === 'function') {
              const ctx = span.spanContext()
              const traceId = ctx?.traceId
              if (traceId) {
                const originalEnd = (span as any).end.bind(span)
                let ended = false

                ;(span as any).end = function pulseInterceptedRootSpanEnd(this: typeof span, ...args: unknown[]) {
                  if (ended) return
                  const aggregator = getTraceAggregator()
                  const activeCount = aggregator.getActiveSpanCount(traceId)

                  const executeEnd = () => {
                    if (ended) return
                    ended = true
                    // Call originalEnd with truthful completion time, ensuring parent.end >= child.end
                    originalEnd.apply(this, args.length > 0 ? args : undefined)
                  }

                  if (activeCount > 1) {
                    // In-flight child spans detected; defer ending until child spans complete
                    aggregator.waitForActiveChildren(traceId, executeEnd, 10000)
                  } else {
                    // Defer by setImmediate to give any async handler returning a Promise or chaining
                    // an unawaited microtask the opportunity to begin its child span
                    setImmediate(() => {
                      const countNow = aggregator.getActiveSpanCount(traceId)
                      if (countNow > 1) {
                        aggregator.waitForActiveChildren(traceId, executeEnd, 10000)
                      } else {
                        executeEnd()
                      }
                    })
                  }
                }
              }
            }
          } catch {
            // Never crash from a hook — isolated by design
          }
        },

        responseHook: (span, response) => {
          try {
            const res = response as unknown as Record<string, unknown>
            // Guard: if response object is incomplete (socket died before
            // headers arrived), mark it so we can track in dashboards
            if (res.statusCode == null) {
              span.setAttribute('pulse.http.incomplete_response', true)
            }
          } catch {
            // Never crash from a hook
          }
        },
      })
    )
  }

  if (resolved.express) {
    instrumentations.push(new ExpressInstrumentation())
  }

  if (resolved.fastify) {
    instrumentations.push(new FastifyOtelInstrumentation({
      registerOnInitialization: true,
      instrumentHooks: resolved.fastifyConfig.captureHooks,
    }))
  }

  if (resolved.undici) {
    instrumentations.push(
      new UndiciInstrumentation({
        ignoreRequestHook: (request: unknown) => {
          if (context.active().getValue(SUPPRESS_INNER_HTTP) === true) return true
          if (!client.initialized) return false
          try {
            const reqCheck = request as { headers?: Record<string, string | string[]> | string[] }
            if (reqCheck.headers) {
               // In undici, headers can be an array of strings or an object
               if (Array.isArray(reqCheck.headers)) {
                   for (let i = 0; i < reqCheck.headers.length; i += 2) {
                       if (reqCheck.headers[i]?.toLowerCase() === 'x-pulse-internal' && reqCheck.headers[i + 1] === '1') {
                           return true
                       }
                   }
               } else if (reqCheck.headers['x-pulse-internal'] === '1') {
                   return true
               }
            }

            const routes = ConfigManager.getInstance().getConfig().transport.routes
            const req = request as Record<string, unknown>
            const rawOrigin = req.origin ?? req['origin']
            const rawPath = req.path ?? req['path'] ?? req.pathname
            const url = rawOrigin
              ? new URL(String(rawPath ?? '/'), String(rawOrigin))
              : new URL(String(req.url ?? ''))
            return Object.values(routes).some(route => isInternalSdkUrl(url, new URL(route.url)))
          } catch {
            return false
          }
        },
      })
    )
  }

  if (resolved.graphql) {
    const graphqlInstrumentation = createGraphQLInstrumentation(
      resolved.graphqlConfig,
      resolved.graphqlConfig
    )
    if (graphqlInstrumentation) {
      instrumentations.push(graphqlInstrumentation)
    }
  }

  if (resolved.prisma) {
    const prismaInstrumentation = createPrismaInstrumentation(
      resolved.prismaConfig,
      resolved.prismaConfig
    )
    if (prismaInstrumentation) {
      instrumentations.push(prismaInstrumentation)
    }
  }

  if (resolved.mongodb) {
    const mongoInstrumentation = createMongoDBInstrumentation(
      true,
      { enhancedDatabaseReporting: resolved.captureConfig.body },
      resolved.captureConfig
    )
    if (mongoInstrumentation) {
      instrumentations.push(mongoInstrumentation)
    }
  }

  if (resolved.redis) {
    const redisInstrumentation = createRedisInstrumentation(
      true,
      resolved.redisConfig,
      resolved.captureConfig
    )
    if (redisInstrumentation) {
      instrumentations.push(redisInstrumentation)
    }
    const ioRedisInstrumentation = createIORedisInstrumentation(
      true,
      resolved.redisConfig,
      resolved.captureConfig
    )
    if (ioRedisInstrumentation) {
      instrumentations.push(ioRedisInstrumentation)
    }
  }

  if (resolved.bullmq) {
    const bullmqInstrumentation = createBullMQInstrumentation(
      true,
      resolved.bullmqConfig,
      resolved.captureConfig
    )
    if (bullmqInstrumentation) {
      instrumentations.push(bullmqInstrumentation)
    }
  }

  if (resolved.axios) {
    const axiosInstrumentation = createAxiosInstrumentation(true, {
      captureRequestData: resolved.captureConfig.body,
      captureResponseData: resolved.captureConfig.response,
    }, resolved.captureConfig)
    if (axiosInstrumentation) {
      // Track teardown so reset() can fully unwind the patch.
      g[TEARDOWN_REGISTRY]!.push(axiosInstrumentation.teardown)
      // setup() is async (ESM-safe module loading) — track promise to await in init
      pendingAsyncSetup = axiosInstrumentation.setup().catch((err: unknown) => {
        logger.warn('Axios instrumentation setup failed', { error: String(err) })
      })
    }
  }

  if (resolved.pg) {
    const pgInstrumentation = createPgInstrumentation(
      true,
      { captureQueries: resolved.pgConfig.captureQueries, captureParams: resolved.pgConfig.captureParams },
      resolved.captureConfig
    )
    if (pgInstrumentation) {
      instrumentations.push(pgInstrumentation)
    }
  }

  if (resolved.mysql2) {
    const mysqlInstrumentation = createMySQLInstrumentation(
      true,
      { captureQueries: resolved.mysql2Config.captureQueries },
      resolved.captureConfig
    )
    if (mysqlInstrumentation) {
      instrumentations.push(mysqlInstrumentation)
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
    pg: resolved.pg,
    mysql2: resolved.mysql2,
    eventEmitterPatch: resolved.eventEmitterPatch,
    fastifyCaptureHooks: resolved.fastifyConfig.captureHooks,
    fastifyCaptureValidationErrors: resolved.fastifyConfig.captureValidationErrors,
    graphqlCaptureResolvers: resolved.graphqlConfig.captureResolvers,
    prismaCaptureQueries: resolved.prismaConfig.captureQueries,
    prismaCaptureParams: resolved.prismaConfig.captureParams,
    pgCaptureQueries: resolved.pgConfig.captureQueries,
    mysql2CaptureQueries: resolved.mysql2Config.captureQueries,
    count: registeredInstrumentations.length,
  })

  // Apply EventEmitter context binding patch so listeners preserve
  // the async context (trace ID, span) that was active at registration time.
  if (resolved.eventEmitterPatch) {
    patchEventEmitter()
  }

  // Install the HTTP lifecycle guard to protect against socket
  // destruction race conditions in OTel's HTTP instrumentation.
  installHttpLifecycleGuard()
}

/**
 * Install safe module-load hooks as soon as the SDK package is imported.
 *
 * This closes the common ESM/CJS race where application code imports Pulse,
 * starts `createSDK()`, and imports DB clients while the one remote-config
 * request is still in flight. The early hooks use privacy-safe defaults and
 * a no-op/proxy tracer until `initTracer()` installs the real provider. Once
 * remote config arrives, `registerAutoInstrumentations()` rebuilds the same
 * hooks from the authoritative backend snapshot.
 */
export function registerBootstrapAutoInstrumentations(): void {
  const g = getGlobalState()
  if (g[INSTRUMENTATION_GUARD]) return

  g[INSTRUMENTATION_GUARD] = true
  g[BOOTSTRAP_GUARD] = true
  g[TEARDOWN_REGISTRY] = []

  // Ensure Node.js ESM customization hooks are registered as early as possible
  registerEsmLoaderHooks()

  const captureConfig: TraceCaptureConfig = {
    headers: false,
    body: false,
    response: false,
    query: false,
    cookies: false,
  }

  const instrumentations = [
    new HttpInstrumentation({
      ignoreOutgoingRequestHook: () => context.active().getValue(SUPPRESS_INNER_HTTP) === true,
    }),
    new ExpressInstrumentation(),
    new FastifyOtelInstrumentation({
      registerOnInitialization: true,
      instrumentHooks: true,
    }),
    new UndiciInstrumentation({
      ignoreRequestHook: () => context.active().getValue(SUPPRESS_INNER_HTTP) === true,
    }),
    createGraphQLInstrumentation(true, { enabled: true, captureResolvers: true }),
    createPrismaInstrumentation(true, { enabled: true, captureQueries: true, captureParams: false }),
    createMongoDBInstrumentation(true, { enhancedDatabaseReporting: false }, captureConfig),
    createRedisInstrumentation(true, {}, captureConfig),
    createIORedisInstrumentation(true, {}, captureConfig),
    createBullMQInstrumentation(
      true,
      {
        enabled: true,
        emitCreateSpansForBulk: true,
        emitCreateSpansForFlow: true,
        requireParentSpanForPublish: false,
      },
      captureConfig,
    ),
    createPgInstrumentation(true, { captureQueries: false, captureParams: false }, captureConfig),
    createMySQLInstrumentation(true, { captureQueries: false }, captureConfig),
  ].filter(Boolean)

  if (instrumentations.length > 0) {
    g[UNREGISTER_FN] = registerInstrumentations({
      instrumentations: instrumentations as any[],
    })
  }

  // NOTE: patchEventEmitter() is intentionally NOT called during bootstrap.
  // Global prototype patching must be strictly governed by configuration.
  installHttpLifecycleGuard()

  getLogger().debug('Bootstrap auto-instrumentation hooks registered before remote config', {
    count: instrumentations.length,
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
  delete g[BOOTSTRAP_GUARD]
  delete g[TEARDOWN_REGISTRY]
  delete g[UNREGISTER_FN]
  pendingAsyncSetup = null

  // Remove the EventEmitter context binding patch so the next register
  // call rebuilds from scratch with the latest configuration.
  try {
    unpatchEventEmitter()
  } catch (err) {
    logger.warn('EventEmitter unpatch threw', { error: err })
  }

  // Remove the HTTP lifecycle guard
  try {
    uninstallHttpLifecycleGuard()
  } catch (err) {
    logger.warn('HTTP lifecycle guard uninstall threw', { error: err })
  }
}

function isRequestProtocolEnabled(request: unknown, httpEnabled: boolean, httpsEnabled: boolean): boolean {
  let https = false
  try {
    if (typeof request === 'string' || request instanceof URL) {
      https = new URL(String(request)).protocol === 'https:'
    } else if (request && typeof request === 'object') {
      const value = request as Record<string, unknown>
      const socket = value.socket as Record<string, unknown> | undefined
      const agent = value.agent as Record<string, unknown> | undefined
      const protocol = value.protocol ?? agent?.protocol
      if (typeof protocol === 'string') https = protocol.toLowerCase() === 'https:'
      else if (socket?.encrypted === true) https = true
      else {
        const candidate = value.href ?? value.origin
        if (typeof candidate === 'string') https = new URL(candidate).protocol === 'https:'
      }
    }
  } catch {
    // Unknown Node request shapes are treated as HTTP and still follow policy.
  }
  return https ? httpsEnabled : httpEnabled
}

function isInternalSdkUrl(target: URL, ingest: URL): boolean {
  return target.origin === ingest.origin && target.pathname === ingest.pathname
}

export { GraphQLInstrumentation, MongoDBInstrumentation, RedisInstrumentation, PrismaInstrumentation, BullMQInstrumentation }
