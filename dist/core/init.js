import { createHash } from 'node:crypto';
import { sdkInitOptionsSchema } from '../types/config.js';
import { client } from './client.js';
import { SDKError } from './errors.js';
import { BACKEND_BASE_URL } from '../constants/defaults.js';
import { waitForShutdownCompletion, registerSignalHandlers, registerExitPersistenceHandler, isSDKShuttingDown } from './lifecycle.js';
import { getLogger, setDebugMode, setLogLevel } from '../utils/logger.js';
import { RemoteConfigClient } from './remote-config-client.js';
import { validateApiKey } from './api-key.js';
import { assertRemoteConfig } from './config-validator.js';
import { classifyError, isPermanentError } from './retry-classifier.js';
import { BackgroundRecoveryWorker } from './recovery-worker.js';
import { ConfigManager } from './config-manager.js';
import { ConfigApplier } from './config-applier.js';
import { KillswitchEngine } from './killswitch-engine.js';
import { EntitlementGate } from './entitlement-gate.js';
import { SamplingEngine } from './sampling-engine.js';
import { FeatureController } from './feature-controller.js';
import { LimitsEngine } from './limits-engine.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { TransportRouter } from '../transport/transport-router.js';
import { SerializationPool } from '../transport/serialization-pool.js';
import { tenantGovernor } from './tenant-isolation.js';
import { adaptivePressure } from '../utils/adaptive-pressure.js';
import { quotaController } from './quota-controller.js';
import { costGovernor } from '../utils/cost-governor.js';
import { cardinalityGovernor } from '../utils/cardinality-governor.js';
import { TRACING_DEFAULTS } from '../constants/internal-defaults.js';
import { initTracer, shutdownTracer } from '../tracing/tracer.js';
import { registerAutoInstrumentations, registerBootstrapAutoInstrumentations, resetAutoInstrumentations, waitForPendingInstrumentations, } from '../instrumentation/auto-instrument.js';
import { setupGlobalErrorHandlers, resetGlobalErrorHandlers } from '../instrumentation/global-errors.js';
import { otelMetrics } from '../metrics/otel-adapter.js';
import { metricsRegistry } from '../metrics/registry.js';
import { LoggingSubsystem } from '../subsystems/logging-subsystem.js';
import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js';
import { CronSubsystem } from '../subsystems/cron-subsystem.js';
import { RuntimeMetricsSubsystem } from '../subsystems/runtime-metrics-subsystem.js';
import { getSessionManager, resetSessionManager } from '../session/session-manager.js';
import { processEvent } from './event-pipeline.js';
import { eventQueue } from '../transport/queue.js';
import { persistentStorage } from '../storage/persistent-storage.js';
import { persistenceGovernor } from '../storage/persistence-governor.js';
import { initializePlugins } from '../plugins/index.js';
import { sourceMapResolver } from '../processors/source-map-resolver.js';
import { slowRequestDetector } from '../processors/slow-request-detector.js';
import { errorDeduplicator } from '../processors/deduplicator.js';
import { detectResources } from '../utils/resource-detector.js';
import { resolveMaxMemoryMb } from '../utils/memory-detector.js';
/**
 * Initialize from exactly one complete remote snapshot returned by POST
 * /v1/init. Failure is fail-open to the host application but does not invent
 * a runtime configuration or start telemetry with defaults.
 */
export async function init(options) {
    let normalizedOptions;
    if (typeof options === 'string') {
        normalizedOptions = { apiKey: options };
    }
    else if (options && typeof options === 'object') {
        normalizedOptions = { ...options };
    }
    else {
        normalizedOptions = { apiKey: '' };
    }
    // Fallback to environment variables if apiKey is not explicitly set
    if (!normalizedOptions.apiKey && typeof process !== 'undefined' && process.env) {
        const envKey = process.env['LYNKTRACE_API_KEY'] || process.env['PULSE_API_KEY'] || process.env['PULSE_KEY'];
        if (envKey && typeof envKey === 'string' && envKey.trim().length > 0) {
            normalizedOptions = { ...normalizedOptions, apiKey: envKey.trim() };
        }
    }
    await waitForShutdownCompletion();
    if (isSDKShuttingDown() || client.getState() === 'stopping') {
        return undefined;
    }
    if (client.getState() === 'stopped') {
        client.setState('created');
    }
    // Initialization owns lifecycle state from the moment its promise is
    // published. A concurrent malformed call is an inert no-op; it must never
    // reset instrumentation, buffers, or the state machine underneath startup.
    const existing = client.getInitPromise();
    if (existing) {
        const validationError = checkInitOptions(normalizedOptions);
        if (validationError) {
            getLogger().warn('Ignoring invalid init options while initialization is in progress', {
                error: validationError.message,
            });
            return existing;
        }
        if (!client.hasSamePendingIdentity(normalizedOptions)) {
            throw new SDKError('Telemetry initialization already in progress with different options', 'SDK_INIT_IN_PROGRESS');
        }
        return existing;
    }
    setDebugMode(normalizedOptions.debug ?? false);
    if (normalizedOptions.logLevel)
        setLogLevel(normalizedOptions.logLevel);
    if (client.initialized) {
        const validationError = checkInitOptions(normalizedOptions);
        if (validationError) {
            getLogger().warn('Ignoring invalid re-initialization options; keeping current SDK configuration', {
                error: validationError.message,
            });
            return ConfigManager.getInstance().getConfig();
        }
        if (!client.hasSameIdentity(normalizedOptions)) {
            throw new SDKError('Telemetry already initialized with different options', 'SDK_ALREADY_INITIALIZED');
        }
        return ConfigManager.getInstance().getConfig();
    }
    const validationError = checkInitOptions(normalizedOptions);
    if (validationError) {
        const logger = getLogger();
        if (validationError.code === 'INVALID_API_KEY' || validationError.code === 'SDK_API_KEY_MISSING') {
            logger.error('SDK disabled: missing or invalid API key');
        }
        else {
            logger.error('SDK disabled: invalid telemetry init options');
        }
        resetAutoInstrumentations();
        eventQueue.drainAll();
        await enterDormantState(validationError, normalizedOptions);
        if (client.getState() !== 'stopping' && client.getState() !== 'stopped') {
            try {
                client.setState('disabled');
            }
            catch { }
        }
        return undefined;
    }
    registerBootstrapAutoInstrumentations();
    if (client.getState() === 'recovering') {
        if (!client.hasSameIdentity(normalizedOptions)) {
            throw new SDKError('Telemetry initialization already in progress with different options', 'SDK_INIT_IN_PROGRESS');
        }
        BackgroundRecoveryWorker.stop();
    }
    client.setPendingIdentity(normalizedOptions);
    const operation = initialize(normalizedOptions);
    client.setInitPromise(operation);
    try {
        return await operation;
    }
    finally {
        client.clearPendingIdentity();
        client.setInitPromise(null);
    }
}
async function initialize(options) {
    const logger = getLogger();
    if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
        return undefined;
    }
    client.setOptions(options);
    client.initBreadcrumbs(100);
    client.setState('initializing');
    logger.info('Telemetry initialization started', {
        endpoint: '/v1/init',
    });
    try {
        // Startup performs one config operation. Transient failures may use the
        // bounded /v1/init retry; there is no config prefetch, fallback, or
        // immediate /v1/sdk-config request.
        const remoteClient = new RemoteConfigClient({
            apiKey: options.apiKey,
            initTimeoutMs: options.initTimeoutMs,
            initRetries: options.initRetries,
        });
        const response = await remoteClient.initialize();
        if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
            return undefined;
        }
        return await activateSDK(remoteClient, response, options, 'cold_start');
    }
    catch (error) {
        if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
            return undefined;
        }
        logger.error('Telemetry initialization failed; entering dormant state', { error });
        await enterDormantState(error, options);
        return undefined;
    }
}
export async function activateSDK(remoteClient, response, options, mode = 'cold_start') {
    const logger = getLogger();
    const manager = ConfigManager.getInstance();
    if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
        return undefined;
    }
    try {
        assertRemoteConfig(response.config);
        const config = manager.initialize(remoteClient, response.config);
        client.setInitResponse(response);
        client.applyRemoteIdentity(config);
        const killswitchEngine = KillswitchEngine.initialize(config.killswitches);
        const isAdaptive = config.sampling.adaptive ??
            config.features.adaptiveSampling ??
            false;
        const samplingEngine = SamplingEngine.initialize(config.sampling, {
            adaptive: isAdaptive,
        });
        const featureController = FeatureController.initialize(config.features);
        const limitsEngine = LimitsEngine.initialize(config.limits);
        const securityScrubber = SecurityScrubber.initialize(config.privacy);
        const entitlementGate = EntitlementGate.initialize(config.entitlements);
        tenantGovernor.configure(config.limits.tenantGovernance);
        tenantGovernor.start();
        persistenceGovernor.configure(config.limits.persistenceGovernance);
        SerializationPool.initialize(1);
        // Disk replay is required before initialization completes, but it does not
        // depend on transport construction or subsystem registration. Start it
        // early so its file I/O overlaps SDK-owned CPU setup instead of extending
        // the application readiness path.
        const persistedEventsPromise = setupPersistentStorage(options.apiKey, config, options);
        const transportRouter = await TransportRouter.initialize(config.transport, options.apiKey, undefined, config.limits);
        if (config.killswitches.disableTransport || config.killswitches.disableSDK)
            transportRouter.disable();
        killswitchEngine.registerSubsystem('disableTransport', {
            shutdown: () => transportRouter.disable(),
            startup: () => {
                if (!manager.getConfig().killswitches.disableSDK)
                    transportRouter.enable();
            },
        });
        killswitchEngine.registerSubsystem('disableSDK', {
            shutdown: () => transportRouter.disable(),
            startup: () => {
                if (!manager.getConfig().killswitches.disableTransport)
                    transportRouter.enable();
            },
        });
        costGovernor.updateFromConfig({
            maxSpansPerTrace: config.limits.maxSpansPerTrace,
            maxTraceDurationMs: config.tracing?.maxTraceDurationMs ?? TRACING_DEFAULTS.maxTraceDurationMs,
        });
        costGovernor.start();
        if (config.metrics) {
            cardinalityGovernor.configure({
                maxTotalSeries: config.metrics.cardinalityLimit,
                maxDimensionsPerMetric: config.metrics.maxDimensionsPerMetric,
                maxSeriesPerMetric: config.metrics.maxSeriesPerMetric,
            });
        }
        cardinalityGovernor.start();
        eventQueue.configure(config.limits.maxQueueSize);
        if (options.plugins?.length)
            await initializePlugins(options.plugins, config, client.metadata);
        for (const processor of options.eventProcessors ?? [])
            client.registerEventProcessor(processor);
        if (options.sourceMaps) {
            sourceMapResolver.configure({
                sourceMapPaths: options.sourceMaps.paths ? [...options.sourceMaps.paths] : [],
                allowRemoteSourceMaps: options.sourceMaps.allowRemote ?? false,
                embedSourceContent: options.sourceMaps.embedSourceContent ?? false,
            });
        }
        if (options.handleSignals !== false) {
            registerSignalHandlers();
        }
        errorDeduplicator.start();
        metricsRegistry.start();
        configureAdaptivePressure(config);
        adaptivePressure.start();
        // Dynamic module loading is independent of the remaining local setup.
        // Await it before the SDK accepts capture traffic below.
        const payloadScrubberPromise = configurePayloadScrubber(config);
        void payloadScrubberPromise.catch(() => { });
        const resources = detectResources(client.metadata.sdkVersion);
        const startTracing = async () => {
            const active = manager.getConfig();
            if (active.killswitches.disableTracing)
                return;
            initTracer(active, resources);
            registerAutoInstrumentations();
            await waitForPendingInstrumentations();
        };
        const stopTracing = async () => {
            await shutdownTracer();
            resetAutoInstrumentations();
        };
        await featureController.register('tracing', startTracing, stopTracing);
        killswitchEngine.registerSubsystem('disableTracing', {
            shutdown: stopTracing,
            startup: () => {
                if (featureController.isEnabled('tracing'))
                    startTracing();
            },
        });
        const startMetrics = () => {
            const active = manager.getConfig();
            if (active.killswitches.disableMetrics)
                return;
            otelMetrics.init({
                service: active.sdk.service ?? active.sdk.projectId,
                environment: client.metadata.environment,
                release: client.metadata.release,
            }, {
                maxHistogramBuckets: 160,
                percentiles: [50, 75, 90, 95, 99],
                cardinalityLimit: active.metrics?.cardinalityLimit ?? 2_000,
            }, resources);
        };
        RuntimeMetricsSubsystem.getInstance().configure(config);
        const stopMetrics = async () => {
            RuntimeMetricsSubsystem.getInstance().stop();
            await otelMetrics.shutdown();
        };
        await featureController.register('metrics', startMetrics, stopMetrics);
        killswitchEngine.registerSubsystem('disableMetrics', {
            shutdown: stopMetrics,
            startup: () => {
                if (featureController.isEnabled('metrics'))
                    startMetrics();
            },
        });
        await featureController.register('errors', () => {
            const active = manager.getConfig();
            if (!active.killswitches.disableErrors && EntitlementGate.isAllowed('errors'))
                setupGlobalErrorHandlers();
        }, () => resetGlobalErrorHandlers());
        killswitchEngine.registerSubsystem('disableErrors', {
            shutdown: () => resetGlobalErrorHandlers(),
            startup: () => {
                if (featureController.isEnabled('errors') && EntitlementGate.isAllowed('errors'))
                    setupGlobalErrorHandlers();
            },
        });
        await featureController.register('logging', () => {
            const active = manager.getConfig();
            const subsystem = LoggingSubsystem.initialize(active, event => { processEvent(event); }, client.metadata);
            if (!killswitchEngine.isKilled('disableLogs') && EntitlementGate.isAllowed('logging'))
                subsystem.start();
        }, () => LoggingSubsystem.reset());
        killswitchEngine.registerSubsystem('disableLogs', {
            shutdown: () => LoggingSubsystem.getInstance()?.stop(),
            startup: () => {
                if (EntitlementGate.isAllowed('logging'))
                    LoggingSubsystem.getInstance()?.start();
            },
        });
        await featureController.register('profiling', async () => {
            const active = manager.getConfig();
            const subsystem = ProfilingSubsystem.initialize(active, event => { processEvent(event); }, client.metadata);
            if (!killswitchEngine.isKilled('disableProfiling') && EntitlementGate.isAllowed('profiling')) {
                await subsystem.start();
            }
        }, async () => {
            await ProfilingSubsystem.getInstance()?.stop();
            ProfilingSubsystem.reset();
        });
        killswitchEngine.registerSubsystem('disableProfiling', {
            shutdown: async () => { await ProfilingSubsystem.getInstance()?.stop(); },
            startup: async () => {
                if (EntitlementGate.isAllowed('profiling'))
                    await ProfilingSubsystem.getInstance()?.start();
            },
        });
        await featureController.register('crons', () => { CronSubsystem.initialize(event => { processEvent(event); }, client.metadata, manager.getConfig().crons); }, () => CronSubsystem.reset());
        manager.setApplier(new ConfigApplier({
            identity: async ({ previous, current }) => {
                client.applyRemoteIdentity(current);
                LoggingSubsystem.getInstance()?.updateMetadata(client.metadata);
                ProfilingSubsystem.getInstance()?.updateMetadata(client.metadata);
                CronSubsystem.getInstance()?.updateMetadata(client.metadata);
                // OTel Resource identity is immutable. Restart only providers that
                // remained active; feature/killswitch transitions own starts/stops.
                if (previous.features.tracing && current.features.tracing
                    && !previous.killswitches.disableTracing && !current.killswitches.disableTracing) {
                    await stopTracing();
                    startTracing();
                }
                if (previous.features.metrics && current.features.metrics
                    && !previous.killswitches.disableMetrics && !current.killswitches.disableMetrics) {
                    await stopMetrics();
                    startMetrics();
                }
            },
            killswitches: async ({ diff, current }) => {
                await killswitchEngine.handleConfigChange(diff, current);
            },
            sampling: ({ diff, current }) => {
                samplingEngine.handleConfigChange(diff, current);
                if (diff.changes.has('sampling.profiles'))
                    updateProfilingConfig(current);
            },
            features: async ({ diff, current }) => {
                await featureController.handleConfigChange(diff, current);
                if (pressureFeaturesChanged(diff))
                    configureAdaptivePressure(current);
                RuntimeMetricsSubsystem.getInstance().handleConfigChange(diff, current);
            },
            limits: ({ diff, current }) => {
                limitsEngine.handleConfigChange(diff, current);
                if (diff.changes.has('limits.tenantGovernance')) {
                    tenantGovernor.configure(current.limits.tenantGovernance);
                }
                persistenceGovernor.configure(current.limits.persistenceGovernance);
                if (diff.changes.has('limits.maxMemoryMb'))
                    configureAdaptivePressure(current);
                if (diff.changes.has('limits.maxQueueSize'))
                    eventQueue.configure(current.limits.maxQueueSize);
                if (diff.changes.has('limits.maxSpansPerTrace') || diff.changes.has('tracing.maxTraceDurationMs')) {
                    costGovernor.updateFromConfig({
                        maxSpansPerTrace: current.limits.maxSpansPerTrace,
                        maxTraceDurationMs: current.tracing?.maxTraceDurationMs ?? TRACING_DEFAULTS.maxTraceDurationMs,
                    });
                }
            },
            privacy: async ({ diff, current }) => {
                securityScrubber.handleConfigChange(diff, current);
                await configurePayloadScrubber(current);
            },
            transport: async ({ diff, current }) => {
                await transportRouter.handleConfigChange(diff, current);
            },
            instrumentation: ({ diff, previous, current }) => {
                const tracingLifecycleChanged = diff.sdkChanged
                    || diff.changes.has('features.tracing')
                    || diff.changes.has('killswitches.disableTracing')
                    || diff.changes.has('entitlements.tracing')
                    || diff.changes.has('entitlements.customSpans');
                // A lifecycle transition starts/stops instrumentation from the new
                // snapshot. Rebuild only when tracing remained active throughout.
                if (!tracingLifecycleChanged
                    && previous.features.tracing && current.features.tracing
                    && !killswitchEngine.isKilled('disableTracing')) {
                    resetAutoInstrumentations();
                    registerAutoInstrumentations();
                }
            },
            entitlements: async ({ diff, current }) => {
                await entitlementGate.handleConfigChange(diff, current);
                if ((diff.changes.has('entitlements.tracing') || diff.changes.has('entitlements.customSpans'))
                    && current.features.tracing && !current.killswitches.disableTracing) {
                    resetAutoInstrumentations();
                    registerAutoInstrumentations();
                }
                if (diff.changes.has('entitlements.logging')) {
                    if (current.entitlements.logging && current.features.logging && !current.killswitches.disableLogs) {
                        LoggingSubsystem.getInstance()?.start();
                    }
                    else {
                        LoggingSubsystem.getInstance()?.stop();
                    }
                }
                if (diff.changes.has('entitlements.profiling')
                    && current.entitlements.profiling && current.features.profiling
                    && !current.killswitches.disableProfiling) {
                    await ProfilingSubsystem.getInstance()?.start();
                }
                if (diff.changes.has('entitlements.errors')) {
                    if (current.entitlements.errors && current.features.errors && !current.killswitches.disableErrors) {
                        setupGlobalErrorHandlers();
                    }
                    else {
                        resetGlobalErrorHandlers();
                    }
                }
            },
            offlineQueue: ({ current }) => {
                if (options.offlineQueue !== false && typeof options.offlineQueue !== 'object') {
                    persistentStorage.configure({
                        enabled: current.offlineQueue?.enabled ?? true,
                        maxFileSizeBytes: current.offlineQueue?.maxFileSizeBytes,
                        maxEvents: current.offlineQueue?.maxEvents,
                        eventTtlMs: current.offlineQueue?.eventTtlMs,
                        ioTimeoutMs: current.offlineQueue?.ioTimeoutMs,
                    });
                }
            },
            metrics: ({ diff, current }) => {
                RuntimeMetricsSubsystem.getInstance().handleConfigChange(diff, current);
                if (current.metrics) {
                    cardinalityGovernor.configure({
                        maxTotalSeries: current.metrics.cardinalityLimit,
                        maxDimensionsPerMetric: current.metrics.maxDimensionsPerMetric,
                        maxSeriesPerMetric: current.metrics.maxSeriesPerMetric,
                    });
                }
            },
            tracing: ({ current }) => {
                costGovernor.updateFromConfig({
                    maxSpansPerTrace: current.limits.maxSpansPerTrace,
                    maxTraceDurationMs: current.tracing?.maxTraceDurationMs ?? TRACING_DEFAULTS.maxTraceDurationMs,
                });
            },
        }));
        // Await any asynchronous instrumentation setups (e.g. Axios ESM patching)
        await waitForPendingInstrumentations();
        // Only now may capture paths leave the pre-init buffer.
        await payloadScrubberPromise;
        // Final shutdown check before marking initialized
        if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
            return undefined;
        }
        const persistedEvents = await persistedEventsPromise;
        registerExitPersistenceHandler();
        client.markInitialized();
        filterBufferedEvents(config);
        await replayBufferedEvents(persistedEvents);
        adaptivePressure.resetWarmup();
        const pressureSnapshot = adaptivePressure.getSnapshot();
        const quotaSnapshot = quotaController.getSnapshot();
        logger.info('Telemetry initialized from remote configuration', {
            mode,
            sdkVersion: client.metadata.sdkVersion,
            projectId: config.sdk.projectId,
            activeSubsystems: featureController.getActiveSubsystems(),
            pressureState: pressureSnapshot.state,
            pressureScore: pressureSnapshot.score,
            quotaState: quotaSnapshot.state,
        });
        return manager.getConfig();
    }
    catch (error) {
        logger.error('Telemetry activation failed; entering dormant state', { error });
        await enterDormantState(error, options);
        return undefined;
    }
}
function checkInitOptions(options) {
    try {
        validateApiKey(options.apiKey);
    }
    catch (err) {
        if (err instanceof SDKError)
            return err;
        return new SDKError('apiKey is required', 'INVALID_API_KEY');
    }
    const result = sdkInitOptionsSchema.safeParse(options);
    if (!result.success) {
        const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
        const isApiKeyIssue = result.error.issues.some(issue => issue.path.includes('apiKey'));
        return new SDKError(`Invalid telemetry init options: ${issues.join('; ')}`, isApiKeyIssue ? 'INVALID_API_KEY' : 'INVALID_INIT_OPTIONS', { issues });
    }
    return null;
}
function validateInitOptions(options) {
    const error = checkInitOptions(options);
    if (error)
        throw error;
}
function getQueueUtilization() {
    let utilization = eventQueue.getUtilization();
    const health = TransportRouter.getInstance()?.getHealth();
    if (!health)
        return utilization;
    for (const route of Object.values(health.routes)) {
        if (route.queueCapacity > 0) {
            utilization = Math.max(utilization, route.queueSize / route.queueCapacity);
        }
    }
    return Math.min(1, Math.max(0, utilization));
}
function configureAdaptivePressure(config) {
    adaptivePressure.configure({
        maxMemoryMb: resolveMaxMemoryMb(config.limits.maxMemoryMb),
        getQueueUtilization: getQueueUtilization,
        runtimeMetrics: config.features.runtimeMetrics,
        eventLoopMonitoring: config.features.eventLoopMonitoring,
        gcMonitoring: config.features.gcMonitoring,
    });
}
async function configurePayloadScrubber(config) {
    const { apiPayloadScrubber } = await import('../processors/sanitizer.js');
    apiPayloadScrubber.configure({
        sensitiveHeaders: [...config.privacy.scrubbing.headers],
        sensitiveKeys: [...config.privacy.scrubbing.fields],
        redactRequestBody: !config.privacy.capture.body,
        redactResponseBody: !config.privacy.capture.response,
    });
}
function pressureFeaturesChanged(diff) {
    return diff.changes.has('features.runtimeMetrics')
        || diff.changes.has('features.eventLoopMonitoring')
        || diff.changes.has('features.gcMonitoring');
}
function updateProfilingConfig(config) {
    ProfilingSubsystem.getInstance()?.handleConfigChange(config);
}
function filterBufferedEvents(config) {
    eventQueue.filter(event => {
        if (event.type === 'error')
            return config.features.errors && !config.killswitches.disableErrors;
        if (event.type === 'request')
            return config.features.requestCapture && !config.killswitches.disableTracing;
        if (event.type === 'metric')
            return config.features.metrics && !config.killswitches.disableMetrics;
        return true;
    });
}
async function replayBufferedEvents(persisted) {
    const router = TransportRouter.getInstance();
    const killswitch = KillswitchEngine.getInstance();
    if (router && !killswitch?.isSDKDisabled() && persisted.length > 0) {
        let chunkCount = 0;
        for (let index = 0; index < persisted.length; index++) {
            const ev = persisted[index];
            if (ev && typeof ev === 'object' && 'type' in ev) {
                if (!router.send(ev)) {
                    // Queue saturation is recoverable because replay files remain on
                    // disk until their event IDs are acknowledged. Drain once and retry
                    // admission so startup can continue through large offline queues.
                    await router.flushAll();
                    if (!router.send(ev)) {
                        getLogger().warn('Offline event replay deferred because the transport queue is full', {
                            eventId: ev.eventId,
                            eventType: ev.type,
                        });
                        continue;
                    }
                }
                chunkCount++;
            }
            if (chunkCount >= 1_000) {
                await router.flushAll();
                chunkCount = 0;
            }
            if ((index + 1) % 100 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
    }
    const buffered = eventQueue.drainAll();
    for (let index = 0; index < buffered.length; index++) {
        processEvent(buffered[index]);
        if ((index + 1) % 100 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
}
function setupPersistentStorage(apiKey, config, options) {
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const optQueue = options.offlineQueue;
    const remoteQueue = config.offlineQueue;
    let enabled = remoteQueue?.enabled ?? true;
    let directory;
    let maxFileSizeBytes = remoteQueue?.maxFileSizeBytes;
    let maxEvents = remoteQueue?.maxEvents;
    let eventTtlMs = remoteQueue?.eventTtlMs;
    let ioTimeoutMs = remoteQueue?.ioTimeoutMs;
    if (optQueue === false) {
        enabled = false;
    }
    else if (typeof optQueue === 'object' && optQueue !== null) {
        if (optQueue.enabled !== undefined)
            enabled = optQueue.enabled;
        if (optQueue.directory !== undefined)
            directory = optQueue.directory;
        if (optQueue.maxFileSizeBytes !== undefined)
            maxFileSizeBytes = optQueue.maxFileSizeBytes;
        if (optQueue.maxEvents !== undefined)
            maxEvents = optQueue.maxEvents;
        if (optQueue.eventTtlMs !== undefined)
            eventTtlMs = optQueue.eventTtlMs;
        if (optQueue.ioTimeoutMs !== undefined)
            ioTimeoutMs = optQueue.ioTimeoutMs;
    }
    persistentStorage.configure({
        apiKeyHash,
        enabled,
        ...(directory !== undefined ? { directory } : {}),
        ...(maxFileSizeBytes !== undefined ? { maxFileSizeBytes } : {}),
        ...(maxEvents !== undefined ? { maxEvents } : {}),
        ...(eventTtlMs !== undefined ? { eventTtlMs } : {}),
        ...(ioTimeoutMs !== undefined ? { ioTimeoutMs } : {}),
    });
    if (!enabled) {
        return Promise.resolve([]);
    }
    const persistedEventsPromise = persistentStorage.init();
    void persistedEventsPromise.catch(() => { });
    return persistedEventsPromise;
}
async function enterDormantState(_error, options) {
    const logger = getLogger();
    try {
        await TransportRouter.reset();
    }
    catch { }
    try {
        FeatureController.reset();
    }
    catch { }
    try {
        KillswitchEngine.reset();
    }
    catch { }
    try {
        EntitlementGate.reset();
    }
    catch { }
    try {
        SamplingEngine.reset();
    }
    catch { }
    try {
        LimitsEngine.reset();
    }
    catch { }
    try {
        SecurityScrubber.reset();
    }
    catch { }
    ConfigManager.reset();
    client.clearConfig();
    if (client.getState() !== 'stopping' && client.getState() !== 'stopped') {
        if (client.getState() !== 'recovering' && client.getState() !== 'created' && client.getState() !== 'disabled') {
            try {
                client.setState('recovering');
            }
            catch { }
        }
    }
    const decision = classifyError(_error);
    const permanent = _error !== undefined && (decision.permanent || isPermanentError(_error));
    if (permanent) {
        BackgroundRecoveryWorker.stop();
        logger.warn('Control-plane permanent failure during init; recovery worker will not start', {
            reason: decision.reason,
        });
        return;
    }
    const recoveryOptions = options ?? client.options;
    if (recoveryOptions && !isSDKShuttingDown() && client.getState() === 'recovering') {
        BackgroundRecoveryWorker.start(recoveryOptions, {
            activateFn: async (response) => {
                const recoveryRemoteClient = new RemoteConfigClient({
                    apiKey: recoveryOptions.apiKey,
                    initTimeoutMs: recoveryOptions.initTimeoutMs ?? 10_000,
                    initRetries: 0,
                });
                await activateSDK(recoveryRemoteClient, response, recoveryOptions, 'recovery');
            },
        });
    }
}
export const cleanupFailedInitialization = enterDormantState;
