const route = (name, batchSize, flushIntervalMs, timeoutMs, compression, priority) => ({
  url: `https://ingest.example.test/v1/${name}`,
  batchSize,
  flushIntervalMs,
  timeoutMs,
  compression,
  priority,
})

export const TEST_REMOTE_CONFIG = Object.freeze({
  schemaVersion: 1,
  sdk: { projectId: 'test-project', service: 'test-service', environment: 'test', release: '1.0.0' },
  features: {
    tracing: false, requestCapture: false, errors: false, metrics: false,
    logging: false, profiling: false, crons: false,
    runtimeMetrics: false, eventLoopMonitoring: false, gcMonitoring: false,
  },
  sampling: {
    traces: 0, requests: 0, spans: 0, errors: 0, messages: 0,
    profiles: 0, metrics: 0, logs: 0, events: 0, crons: 0,
    routes: {},
  },
  instrumentation: {
    http: true, https: true, fetch: true, axios: true,
    fastify: { enabled: true, captureHooks: true, captureValidationErrors: true },
    express: { enabled: true },
    graphql: { enabled: false, captureResolvers: false },
    prisma: { enabled: false, captureQueries: false, captureParams: false },
    mongodb: false, redis: false, bullmq: false,
    pg: false, mysql2: false, eventEmitterPatch: true,
  },
  privacy: {
    capture: { headers: false, body: false, response: false, query: false, cookies: false },
    scrubbing: {
      enabled: true,
      headers: ['authorization', 'cookie', 'x-api-key', 'x-auth-token'],
      fields: ['password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey'],
    },
    piiDetection: { enabled: true, maskEmails: true, maskPhones: true, maskIPs: true },
  },
  limits: {
    maxSpansPerTrace: 500, maxSpanAttributes: 100, maxAttributeLength: 2048,
    maxPayloadSize: 262144, maxQueueSize: 10000, maxMemoryMb: 256,
    tenantGovernance: {
      enabled: false, maxTenantsTracked: 1000, quotaPerWindow: 10000,
      windowDurationMs: 60000, criticalReserve: 100,
    },
    persistenceGovernance: {
      maxPersistPerMinute: 20000, adaptive: true, budgetExceededLogIntervalMs: 60000,
    },
  },
  killswitches: {
    disableSDK: false, disableTracing: false, disableMetrics: false,
    disableTransport: false, disableProfiling: false, disableErrors: false, disableLogs: false,
  },
  transport: {
    retry: { enabled: true, maxRetries: 3, backoff: 'exponential', baseDelayMs: 500 },
    queue: { overflowStrategy: 'drop_oldest', maxSize: 10000, criticalReserve: 100 },
    connections: {
      maxTotalConnections: 100,
      maxConnectionsPerRoute: {
        errors: 30, events: 30, traces: 50, spans: 50, metrics: 20,
        logs: 20, profiles: 5, crons: 5, requests: 50,
      },
      acquireTimeoutMs: 5000,
    },
    keepAlive: true,
    routes: {
      traces: route('traces', 500, 5000, 5000, 'gzip', 'high'),
      requests: route('requests', 500, 5000, 3000, 'gzip', 'high'),
      spans: route('spans', 500, 5000, 5000, 'gzip', 'high'),
      errors: route('errors', 100, 1000, 3000, 'gzip', 'critical'),
      metrics: route('metrics', 1000, 10000, 5000, 'gzip', 'normal'),
      logs: route('logs', 200, 10000, 5000, 'gzip', 'normal'),
      profiles: route('profiles', 5, 30000, 15000, 'gzip', 'low'),
      events: route('events', 50, 5000, 5000, 'gzip', 'normal'),
      crons: route('crons', 1, 0, 5000, 'none', 'high'),
    },
  },
  meta: { generatedAt: '2026-07-30T00:00:00.000Z', generatedBy: 'smoke-fixture' },
  entitlements: {
    customSpans: true, customMetrics: true, profiling: true, logging: true,
    crons: true, requestCapture: true, tracing: true,
    errors: true, metrics: true,
  },
})
