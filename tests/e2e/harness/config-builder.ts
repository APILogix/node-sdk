import { createHash } from 'node:crypto'
import type { RemoteConfigResponse, TransportRouteName } from '../../../src/types/config.js'
import type { DeepPartial } from './types.js'

export const ALL_10_ROUTES: readonly TransportRouteName[] = [
  'traces',
  'requests',
  'spans',
  'errors',
  'metrics',
  'logs',
  'profiles',
  'events',
  'crons',
] as const

/**
 * Creates a fully validated Schema-v1 RemoteConfigResponse snapshot with all
 * 10 transport route URLs dynamically mapped to the specified baseUrl.
 */
export function createDefaultMockConfig(
  baseUrl: string,
  overrides: DeepPartial<RemoteConfigResponse> = {},
): RemoteConfigResponse {
  const normalizedBase = (baseUrl || 'http://127.0.0.1:0').replace(/\/+$/, '')

  const routesConfig = Object.fromEntries(
    ALL_10_ROUTES.map(route => [
      route,
      {
        url: `${normalizedBase}/api/v1/${route}`,
        batchSize: route === 'crons' ? 1 : route === 'errors' ? 20 : 50,
        flushIntervalMs: route === 'crons' ? 0 : route === 'errors' ? 100 : 250,
        timeoutMs: 3_000,
        compression: route === 'crons' ? ('none' as const) : ('gzip' as const),
        priority:
          route === 'errors'
            ? ('critical' as const)
            : route === 'traces' || route === 'requests' || route === 'spans' || route === 'crons'
            ? ('high' as const)
            : route === 'profiles'
            ? ('low' as const)
            : ('normal' as const),
      },
    ]),
  ) as unknown as RemoteConfigResponse['transport']['routes']

  const baseConfig: RemoteConfigResponse = {
    schemaVersion: 1,
    sdk: {
      projectId: 'e2e-project-001',
      service: 'e2e-test-service',
      environment: 'test',
      release: '1.0.0',
    },
    features: {
      tracing: true,
      requestCapture: true,
      errors: true,
      metrics: true,
      logging: true,
      profiling: true,
      crons: true,
      runtimeMetrics: false,
      eventLoopMonitoring: false,
      gcMonitoring: false,
    },
    sampling: {
      traces: 1.0,
      requests: 1.0,
      spans: 1.0,
      errors: 1.0,
      messages: 1.0,
      profiles: 1.0,
      metrics: 1.0,
      logs: 1.0,
      events: 1.0,
      crons: 1.0,
      routes: {},
    },
    instrumentation: {
      http: true,
      https: true,
      fetch: true,
      axios: true,
      fastify: { enabled: true, captureHooks: true, captureValidationErrors: true },
      express: { enabled: true },
      graphql: { enabled: false, captureResolvers: false },
      prisma: { enabled: false, captureQueries: false, captureParams: false },
      mongodb: false,
      redis: false,
      bullmq: false,
      pg: false,
      mysql2: false,
      eventEmitterPatch: true,
    },
    privacy: {
      capture: { headers: true, body: true, response: false, query: true, cookies: false },
      scrubbing: {
        enabled: true,
        headers: ['authorization', 'cookie', 'x-api-key', 'x-auth-token'],
        fields: ['password', 'token', 'secret', 'creditCard', 'apiKey', 'accessToken'],
      },
      piiDetection: { enabled: true, maskEmails: true, maskPhones: true, maskIPs: true },
    },
    limits: {
      maxSpansPerTrace: 500,
      maxSpanAttributes: 100,
      maxAttributeLength: 2_048,
      maxPayloadSize: 1_048_576,
      maxQueueSize: 10_000,
      maxMemoryMb: 512,
      tenantGovernance: {
        enabled: false,
        maxTenantsTracked: 1_000,
        quotaPerWindow: 10_000,
        windowDurationMs: 60_000,
        criticalReserve: 100,
      },
      persistenceGovernance: {
        maxPersistPerMinute: 20_000,
        adaptive: true,
        budgetExceededLogIntervalMs: 60_000,
      },
    },
    killswitches: {
      disableSDK: false,
      disableTracing: false,
      disableMetrics: false,
      disableTransport: false,
      disableProfiling: false,
      disableErrors: false,
      disableLogs: false,
    },
    entitlements: {
      customSpans: true,
      customMetrics: true,
      profiling: true,
      logging: true,
      crons: true,
      requestCapture: true,
      tracing: true,
      errors: true,
      metrics: true,
    },
    transport: {
      retry: { enabled: true, maxRetries: 3, backoff: 'exponential', baseDelayMs: 200 },
      queue: { overflowStrategy: 'drop_oldest', maxSize: 10_000, criticalReserve: 100 },
      connections: {
        maxTotalConnections: 50,
        acquireTimeoutMs: 5_000,
      },
      keepAlive: true,
      routes: routesConfig,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'e2e-mock-server',
    },
  }

  const merged = deepMerge(baseConfig, overrides as DeepPartial<RemoteConfigResponse>) as RemoteConfigResponse

  // Ensure transport.queue.maxSize <= limits.maxQueueSize invariant
  const mutableTransport = { ...merged.transport }
  if (mutableTransport.queue && merged.limits?.maxQueueSize !== undefined) {
    if (mutableTransport.queue.maxSize > merged.limits.maxQueueSize) {
      mutableTransport.queue = {
        ...mutableTransport.queue,
        maxSize: merged.limits.maxQueueSize,
      }
    }
  }

  const result: RemoteConfigResponse = {
    ...merged,
    transport: mutableTransport,
    meta: {
      ...merged.meta,
    },
  }

  // Compute and set configHash
  const hash = computeConfigHash(result)
  const finalConfig: RemoteConfigResponse = {
    ...result,
    meta: {
      ...result.meta,
      configHash: hash,
    },
  }

  return finalConfig
}

/**
 * Computes a SHA-256 hash of a RemoteConfigResponse snapshot (excluding meta.configHash).
 */
export function computeConfigHash(config: RemoteConfigResponse): string {
  const clone = structuredClone(config)
  if (clone.meta) {
    delete (clone.meta as { configHash?: string }).configHash
  }
  const hash = createHash('sha256').update(JSON.stringify(clone)).digest('hex')
  return `sha256:${hash}`
}

/**
 * Dynamically rewrites all 10 route URLs in an existing config to point to the new baseUrl.
 */
export function updateConfigRoutes(config: RemoteConfigResponse, baseUrl: string): RemoteConfigResponse {
  const normalizedBase = (baseUrl || 'http://127.0.0.1:0').replace(/\/+$/, '')
  const routes = { ...config.transport.routes }

  for (const routeName of ALL_10_ROUTES) {
    if (routes[routeName]) {
      routes[routeName] = {
        ...routes[routeName],
        url: `${normalizedBase}/api/v1/${routeName}`,
      }
    }
  }

  const updatedWithoutHash: RemoteConfigResponse = {
    ...config,
    transport: {
      ...config.transport,
      routes,
    },
  }

  const updated: RemoteConfigResponse = {
    ...updatedWithoutHash,
    meta: {
      ...updatedWithoutHash.meta,
      configHash: computeConfigHash(updatedWithoutHash),
    },
  }

  return updated
}

/**
 * Recursive deep merge utility for config overrides.
 */
export function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  if (!source || typeof source !== 'object') return target
  const output = { ...target } as Record<string, unknown>
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (value !== undefined) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof output[key] === 'object' &&
        output[key] !== null &&
        !Array.isArray(output[key])
      ) {
        output[key] = deepMerge(output[key] as Record<string, unknown>, value as DeepPartial<Record<string, unknown>>)
      } else {
        output[key] = value
      }
    }
  }
  return output as T
}
