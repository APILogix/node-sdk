/**
 * SDK Initialization — the entry point for configuring and starting the SDK.
 *
 * Flow:
 * 1. Validate user options via zod schema
 * 2. Handshake with server (/v1/init) to get remote config + plan tier
 * 3. Resolve plan features (free / pro / enterprise)
 * 4. Merge user options + remote config into ResolvedSDKConfig
 * 5. Clamp resolved config to plan limits (features OFF if plan doesn't allow)
 * 6. Initialize breadcrumb buffer, plugins, event processors
 * 7. Start batcher, register global error handlers, signal handlers
 * 8. SDK is ready — events flow through the pipeline
 *
 * All features are ON by default — the plan tier caps what's allowed.
 */
import { createHash } from 'crypto';
import { sdkInitOptionsSchema } from '../types/config.js';
import { client } from './client.js';
import { sendInitRequest } from '../transport/sender.js';
import { startBatcher } from '../transport/batcher.js';
import { setupGlobalErrorHandlers } from '../instrumentation/global-errors.js';
import { eventQueue } from '../transport/queue.js';
import { DEFAULT_BASE_URL, DEFAULT_MAX_PAYLOAD_BYTES, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from '../constants/defaults.js';
import { SDKError } from './errors.js';
import { getLogger, setDebugMode, setLogLevel } from '../utils/logger.js';
import { initializePlugins } from '../plugins/index.js';
import { registerSignalHandlers } from './lifecycle.js';
import { sleep } from '../utils/time.js';
import { initTracer } from '../tracing/tracer.js';
import { getSessionManager } from '../session/session-manager.js';
import { resolvePlanFeatures, clampToPlan, validatePluginCount, getOfflineFallbackPlan } from './plan-gate.js';
import { detectResources } from '../utils/resource-detector.js';
import { errorDeduplicator } from '../processors/deduplicator.js';
import { persistentStorage } from '../storage/persistent-storage.js';
import { sourceMapResolver } from '../processors/source-map-resolver.js';
import { metricsRegistry } from '../metrics/registry.js';
import { slowRequestDetector } from '../processors/slow-request-detector.js';
const INIT_MAX_ATTEMPTS = 5;
const INIT_BASE_RETRY_DELAY_MS = 500;
const INIT_MAX_RETRY_DELAY_MS = 5000;
/**
 * Initialize the SDK.
 *
 * @param options - SDK configuration options
 * @returns The resolved remote config, or undefined if init failed gracefully
 */
export async function init(options) {
    // Enable debug mode first so all init logging is visible if requested
    setDebugMode(options.debug ?? false);
    if (options.logLevel) {
        setLogLevel(options.logLevel);
    }
    validateInitOptions(options);
    if (client.initialized) {
        if (!client.hasSameIdentity(options)) {
            throw new SDKError('SDK already initialized with different options', 'SDK_ALREADY_INITIALIZED');
        }
        return client.remoteConfig ?? undefined;
    }
    const existingInit = client.getInitPromise();
    if (existingInit) {
        if (!client.hasSamePendingIdentity(options)) {
            throw new SDKError('SDK initialization already in progress with different options', 'SDK_INIT_IN_PROGRESS');
        }
        return existingInit;
    }
    client.setPendingIdentity(options);
    const initPromise = initialize(options);
    client.setInitPromise(initPromise);
    try {
        return await initPromise;
    }
    finally {
        client.clearPendingIdentity();
        client.setInitPromise(null);
    }
}
async function initialize(options) {
    const logger = getLogger();
    const baseUrl = resolveBaseUrl(options.baseUrl);
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/init`;
    client.setOptions(options);
    // Initialize breadcrumb buffer
    client.initBreadcrumbs(options.maxBreadcrumbs ?? 100);
    logger.info('SDK init started', {
        baseUrl,
        endpoint,
        service: options.service,
        environment: options.environment,
        release: options.release,
        debug: options.debug ?? false,
    });
    for (let attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt += 1) {
        try {
            logger.debug('SDK init request sending', {
                endpoint,
                attempt,
                maxAttempts: INIT_MAX_ATTEMPTS,
            });
            const response = await sendInitRequest(options.apiKey, baseUrl, DEFAULT_TIMEOUT_MS);
            if (response.success !== true) {
                throw new SDKError('Init response was not successful', 'INIT_REJECTED');
            }
            logger.debug('SDK init response received', {
                endpoint,
                attempt,
                projectId: response.projectId,
                hasConfig: isObject(response.config),
                hasIngestion: isObject(response.ingestion),
            });
            const remoteConfig = validateRemoteConfig(response);
            client.setRemoteConfig(remoteConfig);
            client.setInitResponse(response);
            // Resolve plan features from backend response
            const planTier = remoteConfig.plan ?? 'free';
            const planFeatures = resolvePlanFeatures(planTier, remoteConfig.planFeatures);
            logger.info('Plan resolved', {
                tier: planFeatures.tier,
                allowTracing: planFeatures.allowTracing,
                allowMetrics: planFeatures.allowMetrics,
                allowSessions: planFeatures.allowSessions,
                maxBreadcrumbs: planFeatures.maxBreadcrumbs,
            });
            // Merge user options + remote config → raw resolved config (all features ON)
            const rawConfig = mergeConfig(options, remoteConfig, planFeatures);
            // Clamp to plan limits — features above plan are forced OFF with warnings
            const resolvedConfig = clampToPlan(rawConfig, planFeatures);
            client.setResolvedConfig(resolvedConfig);
            // Configure queue
            eventQueue.configure(resolvedConfig.maxQueueSize);
            filterBufferedEvents(resolvedConfig);
            logger.debug('SDK config resolved', {
                plan: resolvedConfig.plan,
                ingestUrl: resolvedConfig.ingestUrl,
                batchSize: resolvedConfig.batchSize,
                flushIntervalMs: resolvedConfig.flushIntervalMs,
                compression: resolvedConfig.compression,
                samplingRate: resolvedConfig.samplingRate,
                enableErrors: resolvedConfig.enableErrors,
                enablePerformance: resolvedConfig.enablePerformance,
                enableTracing: resolvedConfig.enableTracing,
                enableMetrics: resolvedConfig.enableMetrics,
            });
            // Validate plugins against plan limits
            let pluginsToInit = options.plugins ?? [];
            if (pluginsToInit.length > 0) {
                const { allowed, dropped } = validatePluginCount(pluginsToInit, planFeatures);
                if (dropped > 0) {
                    logger.warn(`[Plan: ${planFeatures.tier}] ${dropped} plugin(s) dropped — plan allows max ${planFeatures.maxPlugins}. Upgrade at https://pulse.dev/pricing`);
                    pluginsToInit = pluginsToInit.slice(0, allowed);
                }
                if (pluginsToInit.length > 0) {
                    await initializePlugins(pluginsToInit, resolvedConfig, client.metadata);
                }
            }
            // Register user-provided event processors
            if (options.eventProcessors) {
                for (const processor of options.eventProcessors) {
                    client.registerEventProcessor(processor);
                }
            }
            // Validate beforeSend against plan
            if (options.beforeSend && !planFeatures.allowBeforeSend) {
                logger.warn(`[Plan: ${planFeatures.tier}] beforeSend hook requires a Pro or Enterprise plan — ignored`);
            }
            // Initialize persistent storage and replay persisted events
            const apiKeyHash = createHash('sha256').update(options.apiKey).digest('hex');
            persistentStorage.configure({ apiKeyHash });
            const persistedEvents = await persistentStorage.init();
            for (const event of persistedEvents) {
                eventQueue.add(event);
            }
            // Configure source map resolver if options provided
            if (options.sourceMaps) {
                sourceMapResolver.configure({
                    sourceMapPaths: options.sourceMaps.paths ? Array.from(options.sourceMaps.paths) : [],
                    allowRemoteSourceMaps: options.sourceMaps.allowRemote ?? false,
                    embedSourceContent: options.sourceMaps.embedSourceContent ?? false,
                });
            }
            // Configure slow request detector
            slowRequestDetector.configure({});
            // Start subsystems
            startBatcher({
                batchSize: resolvedConfig.batchSize,
                flushIntervalMs: resolvedConfig.flushIntervalMs,
                logger,
                maxConcurrentSends: resolvedConfig.maxConcurrentSends,
            });
            setupGlobalErrorHandlers();
            registerSignalHandlers();
            errorDeduplicator.start();
            metricsRegistry.start();
            // Initialize OpenTelemetry tracing if enabled (plan-gated)
            if (resolvedConfig.enableTracing) {
                initTracer(resolvedConfig);
            }
            // Initialize session manager if plan allows
            if (planFeatures.allowSessions) {
                getSessionManager();
            }
            // Detect runtime resources (host, container, cloud metadata)
            const resources = detectResources(client.metadata.sdkVersion);
            logger.info('SDK initialized successfully', {
                plan: resolvedConfig.plan,
                service: resolvedConfig.service,
                environment: resolvedConfig.environment,
                release: resolvedConfig.release,
                pluginCount: client.plugins.length,
                features: {
                    errors: resolvedConfig.enableErrors,
                    performance: resolvedConfig.enablePerformance,
                    tracing: resolvedConfig.enableTracing,
                    metrics: resolvedConfig.enableMetrics,
                },
                resources: {
                    hostname: resources['host.name'],
                    runtime: resources['process.runtime.version'],
                    os: resources['os.platform'],
                    containerId: resources['container.id'],
                    cloud: resources['cloud.provider'],
                },
            });
            return remoteConfig;
        }
        catch (error) {
            client.clearConfig();
            if (!isRetryableInitError(error)) {
                client.clear();
                logger.error('SDK initialization failed with a non-retryable error; host application will continue without SDK telemetry', { error, endpoint, attempt, maxAttempts: INIT_MAX_ATTEMPTS });
                return undefined;
            }
            if (attempt >= INIT_MAX_ATTEMPTS) {
                const fallbackConfig = initializeOfflineFallback(options, baseUrl, logger);
                logger.error('SDK initialization failed after retry budget exhausted; using offline fallback telemetry config', { error, endpoint, attempt, maxAttempts: INIT_MAX_ATTEMPTS });
                return fallbackConfig;
            }
            const nextRetryDelayMs = retryDelayMs(attempt);
            logger.warn('SDK init attempt failed; retrying', {
                error,
                endpoint,
                attempt,
                nextAttempt: attempt + 1,
                maxAttempts: INIT_MAX_ATTEMPTS,
                nextRetryDelayMs,
            });
            await sleep(nextRetryDelayMs);
        }
    }
}
// ─── Config Resolution ──────────────────────────────────────────────────────
/**
 * Merge user options + remote config into ResolvedSDKConfig.
 * ALL features default to ON (true) — plan clamping happens after this.
 */
function mergeConfig(options, remote, planFeatures) {
    return {
        apiKey: options.apiKey,
        service: options.service ?? 'unknown-service',
        environment: options.environment ?? 'production',
        release: options.release ?? '0.0.0-unknown',
        debug: options.debug ?? false,
        // Plan info
        plan: planFeatures.tier,
        planFeatures,
        // Feature flags — ALL default to ON (true)
        // User can turn OFF; plan clamping (next step) enforces upper limit
        enableErrors: options.enableErrors ?? true,
        enablePerformance: options.enablePerformance ?? true,
        enableTracing: options.enableTracing ?? true,
        enableMetrics: options.enableMetrics ?? true,
        samplingRate: options.sampleRate ?? remote.samplingRate,
        maxBreadcrumbs: options.maxBreadcrumbs ?? planFeatures.maxBreadcrumbs,
        maxQueueSize: remote.maxQueueSize,
        shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
        ingestUrl: remote.ingestUrl,
        batchSize: options.transport?.batchSize ?? remote.batchSize,
        flushIntervalMs: options.transport?.flushIntervalMs ?? remote.flushIntervalMs,
        maxRetries: options.transport?.maxRetries ?? remote.maxRetries,
        timeoutMs: options.transport?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        compression: options.transport?.compression ?? 'none',
        maxPayloadBytes: options.transport?.maxPayloadBytes ?? remote.maxPayloadBytes,
        maxConcurrentSends: options.transport?.maxConcurrentSends ?? 3,
    };
}
// ─── Validation ─────────────────────────────────────────────────────────────
function validateInitOptions(options) {
    const result = sdkInitOptionsSchema.safeParse(options);
    if (!result.success) {
        const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
        throw new SDKError(`Invalid SDK init options: ${issues.join('; ')}`, 'INVALID_INIT_OPTIONS', { issues });
    }
}
function resolveBaseUrl(userBaseUrl) {
    const baseUrl = userBaseUrl ?? DEFAULT_BASE_URL;
    if (!baseUrl) {
        throw new SDKError('SDK_BASE_URL is required', 'MISSING_BASE_URL');
    }
    validateUrl(baseUrl, 'baseUrl');
    return baseUrl;
}
function validateRemoteConfig(response) {
    const config = isObject(response.config) ? response.config : null;
    const ingestion = isObject(response.ingestion) ? response.ingestion : null;
    if (!config) {
        throw new SDKError('Init config is missing or invalid', 'INVALID_INIT_CONFIG');
    }
    const ingestUrl = stringField(config, ['ingestUrl', 'ingestURL', 'apiEndpoint'])
        ?? stringField(ingestion, ['endpoint', 'ingestUrl', 'apiEndpoint']);
    if (!ingestUrl) {
        throw new SDKError('Init config missing ingestUrl', 'INVALID_INIT_CONFIG');
    }
    validateUrl(ingestUrl, 'ingestUrl');
    return {
        ingestUrl,
        samplingRate: requiredNumberField(config['samplingRate'], 'samplingRate', 0, 1),
        enableErrors: requiredBooleanField(config['enableErrors'], 'enableErrors'),
        enablePerformance: requiredBooleanField(config['enablePerformance'], 'enablePerformance'),
        maxQueueSize: requiredIntField(ingestion?.['maxQueueSize'] ?? ingestion?.['queueSizeLimit'], 'maxQueueSize', 1),
        batchSize: requiredIntField(ingestion?.['batchSize'], 'batchSize', 1),
        flushIntervalMs: requiredIntField(ingestion?.['flushInterval'] ?? ingestion?.['flushIntervalMs'], 'flushIntervalMs', 1),
        maxRetries: optionalIntField(config['maxRetries'], 'maxRetries', DEFAULT_MAX_RETRIES, 0),
        maxPayloadBytes: optionalIntField(config['maxPayloadBytes'], 'maxPayloadBytes', DEFAULT_MAX_PAYLOAD_BYTES, 1),
        // Plan tier (defaults to 'free' if not provided by backend)
        plan: response.plan ?? undefined,
        planFeatures: response.planFeatures ?? undefined,
    };
}
function filterBufferedEvents(config) {
    eventQueue.filter(event => {
        const e = event;
        if (e['type'] === 'request') {
            return config.enablePerformance && Math.random() <= config.samplingRate;
        }
        if (e['type'] === 'error') {
            return config.enableErrors;
        }
        return true;
    });
}
// ─── Field Extractors ───────────────────────────────────────────────────────
function stringField(raw, names) {
    if (!raw)
        return null;
    for (const name of names) {
        const value = raw[name];
        if (typeof value === 'string' && value.trim())
            return value;
    }
    return null;
}
function requiredBooleanField(value, fieldName) {
    if (typeof value !== 'boolean') {
        throw new SDKError(`Init config field ${fieldName} must be boolean`, 'INVALID_INIT_CONFIG', { fieldName });
    }
    return value;
}
function requiredNumberField(value, fieldName, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new SDKError(`Init config field ${fieldName} out of range`, 'INVALID_INIT_CONFIG', {
            fieldName, min, max, value,
        });
    }
    return value;
}
function requiredIntField(value, fieldName, min) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
        throw new SDKError(`Init config field ${fieldName} must be an integer >= ${min}`, 'INVALID_INIT_CONFIG', {
            fieldName, min, value,
        });
    }
    return value;
}
function optionalIntField(value, fieldName, fallback, min) {
    if (value === undefined || value === null)
        return fallback;
    return requiredIntField(value, fieldName, min);
}
function isObject(value) {
    return !!value && typeof value === 'object';
}
function validateUrl(value, fieldName) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('Unsupported protocol');
        }
    }
    catch (error) {
        throw new SDKError(`${fieldName} must be a valid HTTP URL`, 'INVALID_URL', { fieldName }, error);
    }
}
function isRetryableInitError(error) {
    if (!(error instanceof SDKError))
        return false;
    if (error.code === 'NETWORK_ERROR')
        return true;
    const status = Number(error.context.statusCode ?? error.context.status);
    return status === 408 || status === 429 || status >= 500;
}
function retryDelayMs(attempt) {
    const exponential = Math.min(INIT_MAX_RETRY_DELAY_MS, INIT_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
    return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}
function initializeOfflineFallback(options, baseUrl, logger) {
    const planFeatures = getOfflineFallbackPlan();
    const ingestUrl = `${baseUrl.replace(/\/+$/, '')}/v1/events`;
    const remoteConfig = {
        ingestUrl,
        samplingRate: 1,
        enableErrors: true,
        enablePerformance: false,
        maxQueueSize: planFeatures.maxQueueSize,
        batchSize: planFeatures.maxBatchSize,
        flushIntervalMs: DEFAULT_TIMEOUT_MS,
        maxRetries: DEFAULT_MAX_RETRIES,
        maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
        plan: planFeatures.tier,
        planFeatures,
    };
    const resolvedConfig = clampToPlan(mergeConfig(options, remoteConfig, planFeatures), planFeatures);
    client.setRemoteConfig(remoteConfig);
    client.setResolvedConfig(resolvedConfig);
    eventQueue.configure(resolvedConfig.maxQueueSize);
    filterBufferedEvents(resolvedConfig);
    if (options.eventProcessors) {
        for (const processor of options.eventProcessors) {
            client.registerEventProcessor(processor);
        }
    }
    startBatcher({
        batchSize: resolvedConfig.batchSize,
        flushIntervalMs: resolvedConfig.flushIntervalMs,
        logger,
        maxConcurrentSends: resolvedConfig.maxConcurrentSends,
    });
    setupGlobalErrorHandlers();
    registerSignalHandlers();
    errorDeduplicator.start();
    logger.warn('SDK offline fallback initialized', {
        plan: resolvedConfig.plan,
        ingestUrl: resolvedConfig.ingestUrl,
        enableErrors: resolvedConfig.enableErrors,
        enablePerformance: resolvedConfig.enablePerformance,
    });
    return remoteConfig;
}
//# sourceMappingURL=init.js.map