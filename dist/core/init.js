import { createHash } from 'node:crypto';
import { sdkInitOptionsSchema } from '../types/config.js';
import { client } from './client.js';
import { SDKError } from './errors.js';
import { waitForShutdownCompletion, registerSignalHandlers } from './lifecycle.js';
import { getLogger, setDebugMode, setLogLevel } from '../utils/logger.js';
import { RemoteConfigClient } from './remote-config-client.js';
import { ConfigManager } from './config-manager.js';
import { ConfigApplier } from './config-applier.js';
import { KillswitchEngine } from './killswitch-engine.js';
import { EntitlementGate } from './entitlement-gate.js';
import { SamplingEngine } from './sampling-engine.js';
import { FeatureController } from './feature-controller.js';
import { LimitsEngine } from './limits-engine.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { TransportRouter } from '../transport/transport-router.js';
import { tenantGovernor } from './tenant-isolation.js';
import { adaptivePressure } from '../utils/adaptive-pressure.js';
import { costGovernor } from '../utils/cost-governor.js';
import { TRACING_DEFAULTS } from '../constants/internal-defaults.js';
import { initTracer, shutdownTracer } from '../tracing/tracer.js';
import { registerAutoInstrumentations, resetAutoInstrumentations } from '../instrumentation/auto-instrument.js';
import { setupGlobalErrorHandlers, resetGlobalErrorHandlers } from '../instrumentation/global-errors.js';
import { otelMetrics } from '../metrics/otel-adapter.js';
import { metricsRegistry } from '../metrics/registry.js';
import { LoggingSubsystem } from '../subsystems/logging-subsystem.js';
import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js';
import { CronSubsystem } from '../subsystems/cron-subsystem.js';
import { getSessionManager, resetSessionManager } from '../session/session-manager.js';
import { processEvent } from './event-pipeline.js';
import { eventQueue } from '../transport/queue.js';
import { persistentStorage } from '../storage/persistent-storage.js';
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
    await waitForShutdownCompletion();
    setDebugMode(options.debug ?? false);
    if (options.logLevel)
        setLogLevel(options.logLevel);
    validateInitOptions(options);
    if (client.initialized) {
        if (!client.hasSameIdentity(options)) {
            throw new SDKError('SDK already initialized with different options', 'SDK_ALREADY_INITIALIZED');
        }
        return ConfigManager.getInstance().getConfig();
    }
    const existing = client.getInitPromise();
    if (existing) {
        if (!client.hasSamePendingIdentity(options)) {
            throw new SDKError('SDK initialization already in progress with different options', 'SDK_INIT_IN_PROGRESS');
        }
        return existing;
    }
    client.setPendingIdentity(options);
    const operation = initialize(options);
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
    const manager = ConfigManager.getInstance();
    client.setOptions(options);
    client.initBreadcrumbs(options.maxBreadcrumbs ?? 100);
    logger.info('SDK initialization started', {
        endpoint: '/v1/init',
        baseUrl: options.baseUrl,
    });
    try {
        // Startup performs one network operation. No config prefetch, retry,
        // fallback, or immediate /v1/sdk-config request exists.
        const remoteClient = new RemoteConfigClient({
            apiKey: options.apiKey,
            ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        });
        const response = await remoteClient.initialize();
        const config = manager.initialize(remoteClient, response.config);
        client.setInitResponse(response);
        client.applyRemoteIdentity(config);
        const killswitchEngine = KillswitchEngine.initialize(config.killswitches);
        const samplingEngine = SamplingEngine.initialize(config.sampling);
        const featureController = FeatureController.initialize(config.features);
        const limitsEngine = LimitsEngine.initialize(config.limits);
        const securityScrubber = SecurityScrubber.initialize(config.privacy);
        const entitlementGate = EntitlementGate.initialize(config.entitlements);
        tenantGovernor.configure(config.limits.tenantGovernance);
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
            maxTraceDurationMs: TRACING_DEFAULTS.maxTraceDurationMs,
        });
        eventQueue.configure(config.limits.maxQueueSize);
        if (options.plugins?.length)
            await initializePlugins(options.plugins, config, client.metadata);
        for (const processor of options.eventProcessors ?? [])
            client.registerEventProcessor(processor);
        const apiKeyHash = createHash('sha256').update(options.apiKey).digest('hex');
        persistentStorage.configure({ apiKeyHash });
        const persistedEvents = await persistentStorage.init();
        if (options.sourceMaps) {
            sourceMapResolver.configure({
                sourceMapPaths: options.sourceMaps.paths ? [...options.sourceMaps.paths] : [],
                allowRemoteSourceMaps: options.sourceMaps.allowRemote ?? false,
                embedSourceContent: options.sourceMaps.embedSourceContent ?? false,
            });
        }
        slowRequestDetector.configure({});
        registerSignalHandlers();
        errorDeduplicator.start();
        metricsRegistry.start();
        configureAdaptivePressure(config);
        adaptivePressure.start();
        await configurePayloadScrubber(config);
        const resources = detectResources(client.metadata.sdkVersion);
        const startTracing = () => {
            const active = manager.getConfig();
            if (active.killswitches.disableTracing)
                return;
            initTracer(active, resources);
            registerAutoInstrumentations();
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
                cardinalityLimit: 2_000,
            }, resources);
        };
        const stopMetrics = async () => { await otelMetrics.shutdown(); };
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
        await featureController.register('crons', () => { CronSubsystem.initialize(event => { processEvent(event); }, client.metadata); }, () => CronSubsystem.reset());
        await featureController.register('sessionReplay', () => { getSessionManager(); }, () => resetSessionManager());
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
            },
            limits: ({ diff, current }) => {
                limitsEngine.handleConfigChange(diff, current);
                if (diff.changes.has('limits.tenantGovernance')) {
                    tenantGovernor.configure(current.limits.tenantGovernance);
                }
                if (diff.changes.has('limits.maxMemoryMb'))
                    configureAdaptivePressure(current);
                if (diff.changes.has('limits.maxQueueSize'))
                    eventQueue.configure(current.limits.maxQueueSize);
                if (diff.changes.has('limits.maxSpansPerTrace')) {
                    costGovernor.updateFromConfig({
                        maxSpansPerTrace: current.limits.maxSpansPerTrace,
                        maxTraceDurationMs: TRACING_DEFAULTS.maxTraceDurationMs,
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
        }));
        // Only now may capture paths leave the pre-init buffer.
        client.markInitialized();
        filterBufferedEvents(config);
        await replayBufferedEvents(persistedEvents);
        logger.info('SDK initialized from /v1/init configuration', {
            projectId: client.metadata.projectId,
            environment: client.metadata.environment,
            release: client.metadata.release,
            configHash: manager.getConfig().meta.configHash,
            activeSubsystems: featureController.getActiveSubsystems(),
        });
        return manager.getConfig();
    }
    catch (error) {
        logger.error('SDK initialization failed; host application will continue without telemetry', { error });
        await cleanupFailedInitialization();
        return undefined;
    }
}
function validateInitOptions(options) {
    const result = sdkInitOptionsSchema.safeParse(options);
    if (result.success)
        return;
    const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    throw new SDKError(`Invalid SDK init options: ${issues.join('; ')}`, 'INVALID_INIT_OPTIONS', { issues });
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
    const buffered = eventQueue.drainAll();
    const events = [...persisted, ...buffered];
    for (let index = 0; index < events.length; index++) {
        processEvent(events[index]);
        if ((index + 1) % 100 === 0)
            await new Promise(resolve => setImmediate(resolve));
    }
}
async function cleanupFailedInitialization() {
    try {
        await TransportRouter.reset();
    }
    catch { }
    try {
        await shutdownTracer();
    }
    catch { }
    try {
        resetAutoInstrumentations();
    }
    catch { }
    try {
        resetGlobalErrorHandlers();
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
    client.clear();
}
//# sourceMappingURL=init.js.map