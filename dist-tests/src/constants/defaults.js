import { SAFETY_CEILINGS } from './limits.js';
/** Production backend origin used by the SDK control plane. */
export const BACKEND_BASE_URL = 'https://api.lynktrace.com';
/** Default control-plane API base URL alias. */
export const DEFAULT_API_BASE_URL = BACKEND_BASE_URL;
/** Resolve the control-plane origin with support for environment overrides. */
export function resolveApiBaseUrl() {
    if (typeof process !== 'undefined' && process.env) {
        const customUrl = process.env['LYNKTRACE_ENDPOINT'] ||
            process.env['LYNKTRACE_API_URL'] ||
            process.env['LYNKTRACE_BASE_URL'] ||
            process.env['PULSE_ENDPOINT'] ||
            process.env['PULSE_API_URL'] ||
            process.env['PULSE_BASE_URL'] ||
            // Legacy SDK integration tests and deployed applications use this
            // scoped alias. Keep generic BACKEND_URL intentionally unsupported to
            // avoid accidentally routing telemetry through a host application's
            // unrelated backend.
            process.env['SDK_BASE_URL'];
        if (customUrl && typeof customUrl === 'string' && customUrl.trim().length > 0) {
            let resolved = customUrl.trim();
            if (resolved.endsWith('/'))
                resolved = resolved.slice(0, -1);
            resolved = resolved.replace(/^http:\/\/localhost(?::(\d+))?/i, (_match, port) => {
                return port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1';
            });
            return resolved;
        }
    }
    return BACKEND_BASE_URL;
}
export { SAFETY_CEILINGS };
export const DEFAULT_SDK_IDENTITY = Object.freeze({
    projectId: 'default-project',
    service: 'default-service',
    environment: 'production',
    release: '0.0.0',
});
export const DEFAULT_FEATURES = Object.freeze({
    tracing: true,
    requestCapture: true,
    errors: true,
    metrics: true,
    logging: true,
    profiling: true,
    crons: true,
    sessionReplay: true,
    runtimeMetrics: true,
    eventLoopMonitoring: true,
    gcMonitoring: true,
    adaptiveSampling: false,
});
export const DEFAULT_SAMPLING = Object.freeze({
    traces: 1,
    requests: 1,
    spans: 1,
    errors: 1,
    messages: 1,
    profiles: 1,
    replays: 1,
    metrics: 1,
    logs: 1,
    events: 1,
    crons: 1,
    routes: Object.freeze({}),
    adaptive: false,
});
export const DEFAULT_TRANSPORT_ROUTES = Object.freeze({
    traces: Object.freeze({ url: 'https://127.0.0.1:0/v1/traces', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip', priority: 'high' }),
    requests: Object.freeze({ url: 'https://127.0.0.1:0/v1/requests', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 3000, compression: 'gzip', priority: 'high' }),
    spans: Object.freeze({ url: 'https://127.0.0.1:0/v1/spans', batchSize: 500, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip', priority: 'high' }),
    errors: Object.freeze({ url: 'https://127.0.0.1:0/v1/errors', batchSize: 100, flushIntervalMs: 1000, timeoutMs: 3000, compression: 'gzip', priority: 'critical' }),
    metrics: Object.freeze({ url: 'https://127.0.0.1:0/v1/metrics', batchSize: 1000, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip', priority: 'normal' }),
    logs: Object.freeze({ url: 'https://127.0.0.1:0/v1/logs', batchSize: 200, flushIntervalMs: 10000, timeoutMs: 5000, compression: 'gzip', priority: 'normal' }),
    profiles: Object.freeze({ url: 'https://127.0.0.1:0/v1/profiles', batchSize: 5, flushIntervalMs: 30000, timeoutMs: 15000, compression: 'gzip', priority: 'low' }),
    events: Object.freeze({ url: 'https://127.0.0.1:0/v1/events', batchSize: 50, flushIntervalMs: 5000, timeoutMs: 5000, compression: 'gzip', priority: 'normal' }),
    crons: Object.freeze({ url: 'https://127.0.0.1:0/v1/crons', batchSize: 1, flushIntervalMs: 0, timeoutMs: 5000, compression: 'none', priority: 'high' }),
    replays: Object.freeze({ url: 'https://127.0.0.1:0/v1/replays', batchSize: 5, flushIntervalMs: 10000, timeoutMs: 30000, compression: 'gzip', priority: 'low' }),
});
export const DEFAULT_TRANSPORT = Object.freeze({
    retry: Object.freeze({ enabled: true, maxRetries: 3, backoff: 'exponential', baseDelayMs: 500 }),
    queue: Object.freeze({ overflowStrategy: 'drop_oldest', maxSize: 10_000, criticalReserve: 100 }),
    connections: Object.freeze({
        maxTotalConnections: 50,
        maxConnectionsPerRoute: Object.freeze({
            errors: 10,
            events: 10,
            traces: 20,
            spans: 20,
            metrics: 10,
            logs: 10,
            profiles: 5,
            crons: 5,
            requests: 20,
            replays: 5,
        }),
        acquireTimeoutMs: 5000,
    }),
    keepAlive: true,
    routes: DEFAULT_TRANSPORT_ROUTES,
});
export const DEFAULT_OFFLINE_QUEUE = Object.freeze({
    enabled: true,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxEvents: 10_000,
    eventTtlMs: 24 * 60 * 60 * 1000,
    ioTimeoutMs: 5_000,
    flushDebounceMs: 1_000,
});
export const DEFAULT_PROFILING = Object.freeze({
    enabled: true,
    cpu: true,
    heap: true,
    sampleRate: 1,
    maxDurationMs: 30_000,
});
export const DEFAULT_REPLAY = Object.freeze({
    enabled: true,
    sampleRate: 1,
    idleTimeoutMs: 30 * 60 * 1000,
    maxDurationMs: 4 * 60 * 60 * 1000,
    maxBufferSize: 1_000,
    maskAllInputs: true,
});
export const DEFAULT_ERRORS = Object.freeze({
    captureUnhandledRejections: true,
    captureUncaughtExceptions: true,
    captureConsoleErrors: true,
    stackTraceLimit: 50,
    attachSourceContext: true,
    grouping: Object.freeze({
        enabled: true,
        normalizePaths: true,
    }),
});
export const DEFAULT_TRACING = Object.freeze({
    maxSpansPerTrace: 5_000,
    maxSpanAttributes: 200,
    maxTraceDurationMs: 5 * 60 * 1000,
    propagation: Object.freeze({
        w3c: true,
        baggage: true,
        b3: false,
    }),
});
export const DEFAULT_METRICS = Object.freeze({
    runtimeMetrics: true,
    eventLoopMonitoring: true,
    gcMonitoring: true,
    pushIntervalMs: 10_000,
    cardinalityLimit: 2_000,
});
export const DEFAULT_LOGS = Object.freeze({
    enabled: true,
    captureConsole: true,
    levels: Object.freeze(['debug', 'info', 'warning', 'warn', 'error', 'fatal']),
    maxLogSize: 32 * 1024,
});
export const DEFAULT_CRONS = Object.freeze({
    enabled: true,
    checkInMarginMs: 60_000,
    timeoutMs: 300_000,
});
export const DEFAULT_LIMITS = Object.freeze({
    maxSpansPerTrace: 5_000,
    maxSpanAttributes: 200,
    maxAttributeLength: 8_192,
    maxPayloadSize: 4_194_304,
    maxQueueSize: 100_000,
    maxMemoryMb: 256,
    tenantGovernance: Object.freeze({
        enabled: false,
        maxTenantsTracked: 1_000,
        quotaPerWindow: 10_000,
        windowDurationMs: 60_000,
        criticalReserve: 100,
    }),
    persistenceGovernance: Object.freeze({
        maxPersistPerMinute: 100_000,
        adaptive: true,
        budgetExceededLogIntervalMs: 60_000,
    }),
});
export const DEFAULT_KILLSWITCHES = Object.freeze({
    disableSDK: false,
    disableTracing: false,
    disableMetrics: false,
    disableTransport: false,
    disableProfiling: false,
    disableErrors: false,
    disableLogs: false,
});
export const DEFAULT_PRIVACY = Object.freeze({
    capture: Object.freeze({
        headers: false,
        body: false,
        response: false,
        query: false,
        cookies: false,
    }),
    scrubbing: Object.freeze({
        enabled: true,
        headers: Object.freeze(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token']),
        fields: Object.freeze([
            'password', 'token', 'secret', 'creditCard', 'ssn', 'nationalId', 'apiKey',
            'code', 'id_token', 'access_token', 'refresh_token', 'client_secret', 'assertion',
        ]),
    }),
    piiDetection: Object.freeze({
        enabled: true,
        maskEmails: true,
        maskPhones: true,
        maskIPs: true,
        maskCreditCards: true,
        maskSSNs: true,
    }),
});
export const DEFAULT_INSTRUMENTATION = Object.freeze({
    http: true,
    https: true,
    fetch: true,
    axios: true,
    fastify: Object.freeze({ enabled: true, captureHooks: true, captureValidationErrors: true }),
    express: Object.freeze({ enabled: true }),
    graphql: Object.freeze({ enabled: true, captureResolvers: true }),
    prisma: Object.freeze({ enabled: true, captureQueries: true, captureParams: false }),
    mongodb: true,
    redis: true,
    bullmq: true,
    pg: true,
    mysql2: true,
    eventEmitterPatch: false,
});
export const DEFAULT_ENTITLEMENTS = Object.freeze({
    customSpans: true,
    customMetrics: true,
    profiling: true,
    logging: true,
    sessionReplay: true,
    crons: true,
    requestCapture: true,
    tracing: true,
    errors: true,
    metrics: true,
});
export const DEFAULT_META = Object.freeze({
    generatedAt: '1970-01-01T00:00:00.000Z',
    generatedBy: 'sdk-safe-defaults',
    configHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
});
/**
 * Single authoritative immutable composite default snapshot.
 * Deep frozen at process initialization.
 */
export const DEFAULT_REMOTE_CONFIG = Object.freeze({
    schemaVersion: 1,
    sdk: DEFAULT_SDK_IDENTITY,
    features: DEFAULT_FEATURES,
    sampling: DEFAULT_SAMPLING,
    transport: DEFAULT_TRANSPORT,
    offlineQueue: DEFAULT_OFFLINE_QUEUE,
    profiling: DEFAULT_PROFILING,
    replay: DEFAULT_REPLAY,
    errors: DEFAULT_ERRORS,
    tracing: DEFAULT_TRACING,
    metrics: DEFAULT_METRICS,
    logs: DEFAULT_LOGS,
    crons: DEFAULT_CRONS,
    limits: DEFAULT_LIMITS,
    killswitches: DEFAULT_KILLSWITCHES,
    privacy: DEFAULT_PRIVACY,
    instrumentation: DEFAULT_INSTRUMENTATION,
    entitlements: DEFAULT_ENTITLEMENTS,
    meta: DEFAULT_META,
});
/** Safe defaults alias */
export const SAFE_CONFIG_DEFAULTS = DEFAULT_REMOTE_CONFIG;
