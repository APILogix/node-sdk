/**
 * SDK Initialization — refactored for remote-config-driven architecture.
 *
 * Flow:
 * 1. Validate user options via Zod schema
 * 2. Initialize ConfigManager (fetches POST /v1/sdk-config with 3s timeout)
 * 3. Enforce VersionPolicy (blocked/force_upgrade/degraded/ok)
 * 4. Initialize KillswitchEngine (reactive per-subsystem control)
 * 5. Initialize SamplingEngine (FNV-1a deterministic)
 * 6. Initialize FeatureController (skip class instantiation for disabled features)
 * 7. Initialize SecurityScrubber (pre-transport PII/header scrubbing)
 * 8. Initialize LimitsEngine (rate limiting, attribute trimming)
 * 9. Initialize unified TransportRouter (shared connection manager, per-type queues)
 * 10. Register subsystems with FeatureController (tracing, metrics, errors, logging, profiling, crons)
 * 11. Wire config change listeners for hot-swap
 * 12. Start ConfigManager refresh loop
 * 13. Backward-compatible legacy init flow preserved
 *
 * Config merge priority: Baked-in SDK defaults → Remote Config → User init() options.
 */
import { createHash } from 'crypto';
import { sdkInitOptionsSchema } from '../types/config.js';
import { client } from './client.js';
import { sendInitRequest } from '../transport/sender.js';
import { setupGlobalErrorHandlers, resetGlobalErrorHandlers } from '../instrumentation/global-errors.js';
import { eventQueue } from '../transport/queue.js';
import { DEFAULT_BASE_URL, DEFAULT_MAX_PAYLOAD_BYTES, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, SAFE_DEFAULTS_LIMITS } from '../constants/defaults.js';
import { LOGGING_DEFAULTS, PROFILING_DEFAULTS, TRACING_DEFAULTS } from '../constants/internal-defaults.js';
import { SDKError } from './errors.js';
import { getLogger, setDebugMode, setLogLevel } from '../utils/logger.js';
import { initializePlugins } from '../plugins/index.js';
import { registerSignalHandlers } from './lifecycle.js';
import { processEvent } from './event-pipeline.js';
import { sleep } from '../utils/time.js';
import { initTracer, shutdownTracer } from '../tracing/tracer.js';
import { getSessionManager } from '../session/session-manager.js';
import { resolvePlanFeatures, clampToPlan, getOfflineFallbackPlan } from './plan-gate.js';
import { detectResources } from '../utils/resource-detector.js';
import { errorDeduplicator } from '../processors/deduplicator.js';
import { persistentStorage } from '../storage/persistent-storage.js';
import { sourceMapResolver } from '../processors/source-map-resolver.js';
import { metricsRegistry } from '../metrics/registry.js';
import { adaptivePressure } from '../utils/adaptive-pressure.js';
import { otelMetrics } from '../metrics/otel-adapter.js';
import { slowRequestDetector } from '../processors/slow-request-detector.js';
import { registerAutoInstrumentations, resetAutoInstrumentations } from '../instrumentation/auto-instrument.js';
import { costGovernor } from '../utils/cost-governor.js';
// ─── New Remote Config Modules ──────────────────────────────────────────────
import { ConfigManager } from './config-manager.js';
import { diffConfigs } from './config-differ.js';
import { VersionPolicy } from './version-policy.js';
import { KillswitchEngine } from './killswitch-engine.js';
import { EntitlementGate } from './entitlement-gate.js';
import { SamplingEngine } from './sampling-engine.js';
import { FeatureController } from './feature-controller.js';
import { LimitsEngine } from './limits-engine.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { TransportRouter } from '../transport/transport-router.js';
import { LoggingSubsystem } from '../subsystems/logging-subsystem.js';
import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js';
import { CronSubsystem } from '../subsystems/cron-subsystem.js';
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
    // ─── Phase 1: Remote Config Fetch ───────────────────────────────────────
    const configManager = ConfigManager.getInstance();
    let remoteConfigResponse = null;
    try {
        remoteConfigResponse = await configManager.initialize(options);
        logger.info('Remote config loaded', {
            configHash: remoteConfigResponse.meta.configHash,
            environment: remoteConfigResponse.sdk.environment,
        });
    }
    catch (err) {
        logger.warn(`Remote config initialization failed: ${err instanceof Error ? err.message : String(err)}`);
        // ConfigManager falls back to BAKED_IN_REMOTE_CONFIG internally
        remoteConfigResponse = configManager.getConfig();
    }
    // ─── Phase 2: Version Policy Enforcement ────────────────────────────────
    //
    // The wire schema no longer carries a `versionPolicy` block — `enforce()`
    // is now a stub that always returns `ok`. Kept as a phase so that if we
    // bring version gating back later, the call site is unchanged.
    const versionResult = VersionPolicy.enforce();
    if (versionResult.status === 'blocked' || versionResult.status === 'force_upgrade') {
        logger.error(`[VersionPolicy] ${versionResult.status}: ${versionResult.message}`);
        client.clear();
        return undefined;
    }
    const isDegradedMode = versionResult.status === 'degraded';
    if (isDegradedMode) {
        logger.warn(`[VersionPolicy] Degraded mode: ${versionResult.message}`);
    }
    // ─── Phase 3: Control Plane Initialization ──────────────────────────────
    const killswitchEngine = KillswitchEngine.initialize(remoteConfigResponse.killswitches);
    // Global SDK killswitch — everything becomes no-op
    if (killswitchEngine.isSDKDisabled()) {
        logger.error('[KillswitchEngine] SDK is globally disabled. No telemetry will be captured.');
        client.clear();
        return undefined;
    }
    const samplingEngine = SamplingEngine.initialize(remoteConfigResponse.sampling);
    const featureController = FeatureController.initialize(remoteConfigResponse.features);
    const limitsEngine = LimitsEngine.initialize(remoteConfigResponse.limits);
    const securityScrubber = SecurityScrubber.initialize(remoteConfigResponse.privacy);
    const entitlementGate = EntitlementGate.initialize(remoteConfigResponse.entitlements);
    if (isDegradedMode) {
        featureController.setDegradedMode(true);
    }
    // ─── Phase 4: Transport Router ──────────────────────────────────────────
    // Awaited so a previous instance fully drains before we send any new event
    // through the new router. Required for warm-start / hot-reload scenarios.
    const transportRouter = await TransportRouter.initialize(remoteConfigResponse.transport, options.apiKey);
    if (killswitchEngine.isKilled('disableTransport')) {
        transportRouter.disable();
    }
    // Register killswitch handler for transport
    killswitchEngine.registerSubsystem('disableTransport', {
        shutdown: () => transportRouter.disable(),
        startup: () => transportRouter.enable(),
    });
    // Wire cost governor from SDK-internal tracing defaults. These knobs no
    // longer come from the wire schema — they're SDK opinions about safe
    // upper bounds for span fan-out and trace duration.
    costGovernor.updateFromConfig({
        maxSpansPerTrace: TRACING_DEFAULTS.maxSpansPerTrace,
        maxTraceDurationMs: TRACING_DEFAULTS.maxTraceDurationMs,
    });
    // ─── Phase 5: Legacy Init Flow (backward compat) ───────────────────────
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
            // Attach the full remote config response to the resolved config
            const rawConfigWithRemote = { ...rawConfig, remoteConfig: remoteConfigResponse ?? undefined };
            // Clamp to plan limits — features above plan are forced OFF with warnings
            const resolvedConfig = clampToPlan(rawConfigWithRemote, planFeatures);
            client.setResolvedConfig(resolvedConfig);
            // ─── Fallback Control-Plane Derivation ─────────────────────────────
            // The v3 control plane (/v1/sdk-config) owns route URLs, feature
            // flags, sampling rates and killswitches. When it is unreachable the
            // SDK runs on baked-in defaults — which are deliberately inert
            // (placeholder URLs, all features off, sampling 0, transport killed)
            // so a misconfigured SDK never floods an unsuspecting backend. But
            // the legacy /v1/init handshake just proved connectivity and returned
            // concrete backend intent (ingestUrl, samplingRate, plan), so derive
            // a working control-plane snapshot from it. Skipped when the control
            // plane is live — explicit remote config always wins.
            if (!configManager.isLive() && remoteConfigResponse) {
                const bridgedConfig = deriveFallbackRemoteConfig(remoteConfigResponse, resolvedConfig);
                if (bridgedConfig) {
                    logger.info('Control plane unreachable — deriving config from init handshake', {
                        ingestUrl: resolvedConfig.ingestUrl,
                        samplingRate: resolvedConfig.samplingRate,
                    });
                    const bridgeDiff = diffConfigs(remoteConfigResponse, bridgedConfig);
                    remoteConfigResponse = bridgedConfig;
                    if (bridgeDiff.transportChanged) {
                        transportRouter.handleConfigChange(bridgeDiff, bridgedConfig);
                    }
                    if (bridgeDiff.killswitchesChanged) {
                        // Flip disableTransport through the engine (not directly on the
                        // router) so killswitch state and router state stay coherent.
                        await killswitchEngine.handleConfigChange(bridgeDiff, bridgedConfig);
                    }
                    if (bridgeDiff.samplingChanged) {
                        samplingEngine.handleConfigChange(bridgeDiff, bridgedConfig);
                    }
                    if (bridgeDiff.featuresChanged) {
                        await featureController.handleConfigChange(bridgeDiff, bridgedConfig);
                    }
                }
            }
            // Configure pre-init buffer and apply feature gates before replaying it into transport.
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
            // Validate plugins. Plan-based caps were removed in v3 — every plugin
            // the user passes is now accepted unless the FeatureController later
            // refuses it (still TBD; for now plugins always run).
            let pluginsToInit = options.plugins ?? [];
            if (pluginsToInit.length > 0) {
                await initializePlugins(pluginsToInit, resolvedConfig, client.metadata);
            }
            // Register user-provided event processors
            if (options.eventProcessors) {
                for (const processor of options.eventProcessors) {
                    client.registerEventProcessor(processor);
                }
            }
            // beforeSend used to be a paid-plan feature; v3 makes it always
            // available. The hook still runs through the event pipeline's
            // BEFORE_SEND_TIMEOUT_MS guard so a slow user hook can't stall the
            // pipeline.
            // Initialize persistent storage and replay persisted events.
            const apiKeyHash = createHash('sha256').update(options.apiKey).digest('hex');
            persistentStorage.configure({ apiKeyHash });
            const persistedEvents = await persistentStorage.init();
            // Replay through `processEvent` (the full pipeline) rather than
            // directly to the transport, so SecurityScrubber, applyScopeToEvent,
            // dedup, plugin processors, beforeSend, sampling, LimitsEngine, and
            // loadShedder all see replayed events the same as fresh captures.
            // Pre-init events were captured before these were configured —
            // sending them straight to the wire would skip every PII / governance
            // filter (a request body with an Authorization header captured
            // pre-init would reach the backend unredacted otherwise).
            //
            // Replay is throttled with a setImmediate yield every batch to
            // prevent a thundering herd: 10k persisted events all in flight at
            // once would exhaust BatchManager queues, trigger load shedding, and
            // cause legitimate replays to be dropped. Yielding hands control
            // back to the event loop so the transport can drain naturally.
            const REPLAY_BATCH_SIZE = 100;
            const totalReplayCandidates = persistedEvents.length + eventQueue.size();
            if (totalReplayCandidates > 0) {
                logger.info('Replaying events from previous session', {
                    persistedEvents: persistedEvents.length,
                    legacyQueueEvents: eventQueue.size(),
                    batchSize: REPLAY_BATCH_SIZE,
                });
            }
            for (let i = 0; i < persistedEvents.length; i++) {
                processEvent(persistedEvents[i]);
                if ((i + 1) % REPLAY_BATCH_SIZE === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
            const legacyEvents = eventQueue.drainAll();
            for (let i = 0; i < legacyEvents.length; i++) {
                processEvent(legacyEvents[i]);
                if ((i + 1) % REPLAY_BATCH_SIZE === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
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
            // NOTE: setupGlobalErrorHandlers() is intentionally NOT called here.
            // It runs inside the Phase 6 'errors' feature registration below so
            // the remote features.errors toggle is authoritative: disabled at the
            // control plane → no process-level handlers attached at all.
            registerSignalHandlers();
            errorDeduplicator.start();
            metricsRegistry.start();
            // Start the adaptive pressure monitor — load-shedder and
            // persistence-governor consult adaptivePressure.getLevel(), so without
            // start() the singleton never samples memory/GC/event-loop pressure and
            // load shedding would never engage under stress. Each signal family is
            // gated by the corresponding remote-config feature flag so a backend can
            // turn off runtime monitoring without a redeploy.
            adaptivePressure.configure({
                maxMemoryMb: resolvedConfig.remoteConfig?.limits?.maxMemoryMb ?? SAFE_DEFAULTS_LIMITS.maxMemoryMb,
                runtimeMetrics: remoteConfigResponse.features.runtimeMetrics,
                eventLoopMonitoring: remoteConfigResponse.features.eventLoopMonitoring,
                gcMonitoring: remoteConfigResponse.features.gcMonitoring,
            });
            adaptivePressure.start();
            const { apiPayloadScrubber } = await import('../processors/sanitizer.js');
            apiPayloadScrubber.configure(resolvedConfig.dataScrubbing);
            // Detect runtime resources (host, container, cloud metadata)
            const resources = detectResources(client.metadata.sdkVersion);
            // ─── Phase 6: Feature-Controlled Subsystem Registration ───────────
            const eventMetadata = client.metadata;
            // Register tracing subsystem
            await featureController.register('tracing', () => {
                if (!killswitchEngine.isKilled('disableTracing') && resolvedConfig.enableTracing) {
                    initTracer(resolvedConfig, resources);
                    registerAutoInstrumentations({}); // Reads from remote config internally
                }
            }, async () => {
                // Real teardown: a remote features.tracing flip to false must stop
                // span production, not just log. Mirrors the killswitch shutdown.
                logger.info('[FeatureController] Tracing subsystem stopped');
                try {
                    await shutdownTracer();
                }
                catch (err) {
                    logger.error('[FeatureController] shutdownTracer failed', { error: err });
                }
                try {
                    resetAutoInstrumentations();
                }
                catch (err) {
                    logger.error('[FeatureController] resetAutoInstrumentations failed', { error: err });
                }
            });
            killswitchEngine.registerSubsystem('disableTracing', {
                shutdown: async () => {
                    // Real teardown: stop the OTel tracer provider AND uninstall the
                    // auto-instrumentations so no new spans are produced. A bare log
                    // here was a no-op — backend "kill tracing" had no effect.
                    logger.warn('[KillswitchEngine] Tracing killed — shutting down tracer + auto-instrumentation');
                    try {
                        await shutdownTracer();
                    }
                    catch (err) {
                        logger.error('[KillswitchEngine] shutdownTracer failed', { error: err });
                    }
                    try {
                        resetAutoInstrumentations();
                    }
                    catch (err) {
                        logger.error('[KillswitchEngine] resetAutoInstrumentations failed', { error: err });
                    }
                },
                startup: () => {
                    // Refuse to re-init if tracing is already alive — protects
                    // against double-init of NodeTracerProvider when the killswitch
                    // toggles rapidly.
                    if (featureController.isEnabled('tracing')) {
                        initTracer(resolvedConfig, resources);
                        registerAutoInstrumentations({});
                    }
                },
            });
            // Register metrics subsystem
            await featureController.register('metrics', () => {
                if (!killswitchEngine.isKilled('disableMetrics') && resolvedConfig.enableMetrics) {
                    otelMetrics.init({
                        service: resolvedConfig.service,
                        environment: resolvedConfig.environment,
                        release: resolvedConfig.release,
                    }, resolvedConfig.otelMetrics, resources);
                }
            }, async () => {
                // Real teardown: stop the OTel meter provider when the control
                // plane disables metrics, mirroring the killswitch shutdown.
                logger.info('[FeatureController] Metrics subsystem stopped');
                try {
                    await otelMetrics.shutdown();
                }
                catch (err) {
                    logger.error('[FeatureController] otelMetrics.shutdown failed', { error: err });
                }
            });
            killswitchEngine.registerSubsystem('disableMetrics', {
                shutdown: async () => {
                    logger.warn('[KillswitchEngine] Metrics killed — shutting down OTel meter provider');
                    try {
                        await otelMetrics.shutdown();
                    }
                    catch (err) {
                        logger.error('[KillswitchEngine] otelMetrics.shutdown failed', { error: err });
                    }
                },
                startup: () => {
                    if (featureController.isEnabled('metrics')) {
                        otelMetrics.init({
                            service: resolvedConfig.service,
                            environment: resolvedConfig.environment,
                            release: resolvedConfig.release,
                        }, resolvedConfig.otelMetrics, resources);
                    }
                },
            });
            // Register errors subsystem
            await featureController.register('errors', () => {
                if (!killswitchEngine.isKilled('disableErrors')) {
                    setupGlobalErrorHandlers();
                }
            }, () => {
                // Real teardown: detach uncaughtException / unhandledRejection
                // listeners and restore console.error when the control plane
                // disables error collection.
                logger.info('[FeatureController] Errors subsystem stopped');
                try {
                    resetGlobalErrorHandlers();
                }
                catch (err) {
                    logger.error('[FeatureController] resetGlobalErrorHandlers failed', { error: err });
                }
            });
            killswitchEngine.registerSubsystem('disableErrors', {
                shutdown: () => {
                    // Detach the SDK's process-level uncaughtException /
                    // unhandledRejection listeners and unwrap console.error.
                    logger.warn('[KillswitchEngine] Errors killed — detaching global error handlers');
                    try {
                        resetGlobalErrorHandlers();
                    }
                    catch (err) {
                        logger.error('[KillswitchEngine] resetGlobalErrorHandlers failed', { error: err });
                    }
                },
                startup: () => {
                    if (featureController.isEnabled('errors')) {
                        setupGlobalErrorHandlers();
                    }
                },
            });
            // Register logging subsystem. The wire schema no longer carries a
            // `logging` block — we synthesize one from SDK-internal defaults and
            // the `features.logging` toggle so the subsystem signature stays
            // unchanged during the migration.
            await featureController.register('logging', () => {
                if (!killswitchEngine.isKilled('disableLogs')) {
                    const loggingSub = LoggingSubsystem.initialize({
                        ...LOGGING_DEFAULTS,
                        enabled: remoteConfigResponse.features.logging,
                    }, (event) => { processEvent(event); }, eventMetadata);
                    loggingSub.start();
                }
            }, () => {
                LoggingSubsystem.reset();
            });
            killswitchEngine.registerSubsystem('disableLogs', {
                shutdown: () => {
                    const sub = LoggingSubsystem.getInstance();
                    if (sub)
                        sub.stop();
                },
                startup: () => {
                    const sub = LoggingSubsystem.getInstance();
                    if (sub)
                        sub.start();
                },
            });
            // Register profiling subsystem. Same pattern as logging: synthesize
            // the legacy `ProfilingConfig` shape from SDK-internal defaults plus
            // the remote `features.profiling` flag.
            await featureController.register('profiling', async () => {
                if (!killswitchEngine.isKilled('disableProfiling')) {
                    const profilingSub = ProfilingSubsystem.initialize({
                        ...PROFILING_DEFAULTS,
                        enabled: remoteConfigResponse.features.profiling,
                    }, (event) => { processEvent(event); }, eventMetadata);
                    await profilingSub.start();
                }
            }, async () => {
                const sub = ProfilingSubsystem.getInstance();
                if (sub)
                    await sub.stop();
            });
            killswitchEngine.registerSubsystem('disableProfiling', {
                shutdown: async () => {
                    const sub = ProfilingSubsystem.getInstance();
                    if (sub)
                        await sub.stop();
                },
                startup: async () => {
                    const sub = ProfilingSubsystem.getInstance();
                    if (sub)
                        await sub.start();
                },
            });
            // Register crons subsystem
            await featureController.register('crons', () => {
                CronSubsystem.initialize((event) => transportRouter.send(event), eventMetadata);
            }, () => {
                CronSubsystem.reset();
            });
            // Register session replay subsystem
            await featureController.register('sessionReplay', () => {
                if (planFeatures.allowSessions) {
                    getSessionManager();
                }
            }, () => {
                logger.info('[FeatureController] Session replay subsystem stopped');
            });
            // ─── Phase 7: Wire Config Change Listeners ──────────────────────────
            configManager.onConfigChange((diff, newConfig) => {
                logger.info('[ConfigManager] Config changed, propagating to subsystems');
                if (diff.killswitchesChanged) {
                    void killswitchEngine.handleConfigChange(diff, newConfig);
                }
                if (diff.samplingChanged) {
                    samplingEngine.handleConfigChange(diff, newConfig);
                }
                if (diff.featuresChanged || diff.limitsChanged) {
                    adaptivePressure.configure({
                        maxMemoryMb: newConfig.limits.maxMemoryMb,
                        runtimeMetrics: newConfig.features.runtimeMetrics,
                        eventLoopMonitoring: newConfig.features.eventLoopMonitoring,
                        gcMonitoring: newConfig.features.gcMonitoring,
                    });
                }
                if (diff.featuresChanged) {
                    void featureController.handleConfigChange(diff, newConfig);
                    // The logging/profiling subsystems' config is synthesized from
                    // `features.*` plus SDK defaults. When `features` flips, push a
                    // refreshed shape to whichever subsystem is alive so its `enabled`
                    // mirror matches the new feature flag.
                    const loggingSub = LoggingSubsystem.getInstance();
                    if (loggingSub) {
                        loggingSub.handleConfigChange(diff, {
                            ...newConfig,
                            logging: { ...LOGGING_DEFAULTS, enabled: newConfig.features.logging },
                        });
                    }
                    const profilingSub = ProfilingSubsystem.getInstance();
                    if (profilingSub) {
                        profilingSub.handleConfigChange(diff, {
                            ...newConfig,
                            profiling: { ...PROFILING_DEFAULTS, enabled: newConfig.features.profiling },
                        });
                    }
                    const cronSub = CronSubsystem.getInstance();
                    if (cronSub) {
                        cronSub.handleConfigChange(diff, newConfig);
                    }
                }
                if (diff.limitsChanged) {
                    limitsEngine.handleConfigChange(diff, newConfig);
                }
                if (diff.privacyChanged) {
                    securityScrubber.handleConfigChange(diff, newConfig);
                }
                if (diff.transportChanged) {
                    transportRouter.handleConfigChange(diff, newConfig);
                }
                if (diff.entitlementsChanged) {
                    void entitlementGate.handleConfigChange(diff, newConfig);
                }
            });
            // ─── Phase 8: Start Config Refresh Loop ────────────────────────────
            configManager.startRefreshLoop();
            // ─── Done ─────────────────────────────────────────────────────────
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
                activeSubsystems: featureController.getActiveSubsystems(),
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
        // OTel Metrics
        otelMetrics: {
            maxHistogramBuckets: options.otelMetrics?.maxHistogramBuckets ?? 160,
            percentiles: options.otelMetrics?.percentiles ?? [50, 75, 90, 95, 99],
            cardinalityLimit: options.otelMetrics?.cardinalityLimit ?? 2000,
        },
        // Payload Governance
        dataScrubbing: {
            sensitiveHeaders: options.dataScrubbing?.sensitiveHeaders ? Array.from(options.dataScrubbing.sensitiveHeaders) : [],
            sensitiveKeys: options.dataScrubbing?.sensitiveKeys ? Array.from(options.dataScrubbing.sensitiveKeys) : [],
            redactRequestBody: options.dataScrubbing?.redactRequestBody ?? false,
            redactResponseBody: options.dataScrubbing?.redactResponseBody ?? false,
        },
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
    const samplingEngineInstance = SamplingEngine.getInstance();
    eventQueue.filter(event => {
        const e = event;
        if (e['type'] === 'request') {
            if (!config.enablePerformance)
                return false;
            if (config.samplingRate >= 1)
                return true;
            if (config.samplingRate <= 0)
                return false;
            // Deterministic sampling. The engine is initialized in Phase 3 of
            // init() so it's always present when filterBufferedEvents runs;
            // the explicit check is defensive, and falling through means
            // dropping the event rather than non-deterministic Math.random()
            // (which would make sampling decisions inconsistent across nodes).
            if (samplingEngineInstance) {
                const traceId = e['traceId'] ?? e['requestId'] ?? String(e['timestamp']);
                const decision = samplingEngineInstance.shouldSampleTrace(traceId);
                return decision.sampled;
            }
            // SamplingEngine not yet up — drop rather than sample non-deterministically.
            return false;
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
/**
 * Derive a working control-plane snapshot from the legacy init handshake.
 *
 * Baked-in defaults are deliberately inert: empty route URLs, every
 * feature off, sampling rates 0 and `disableTransport` on — so an SDK
 * pointing at a black hole stays quiet. Once the legacy /v1/init
 * handshake succeeds we know the backend's real intent (ingestUrl,
 * samplingRate, plan-clamped feature flags), so we map it onto the v3
 * config shape. Returns null when there is nothing to derive.
 */
function deriveFallbackRemoteConfig(remote, resolved) {
    const transport = deriveTransportFromIngestUrl(remote.transport, resolved.ingestUrl);
    const candidate = {
        ...remote,
        transport: transport ?? remote.transport,
        killswitches: transport
            ? { ...remote.killswitches, disableTransport: false }
            : remote.killswitches,
        features: {
            ...remote.features,
            errors: resolved.enableErrors,
            requestCapture: resolved.enablePerformance,
            tracing: resolved.enableTracing,
            metrics: resolved.enableMetrics,
            runtimeMetrics: resolved.enableMetrics,
            eventLoopMonitoring: resolved.enableMetrics,
            gcMonitoring: resolved.enableMetrics,
            // No legacy flags exist for these — fail open, mirroring
            // mergeConfig's "all features default ON" legacy semantics.
            logging: true,
            profiling: true,
            crons: true,
            sessionReplay: resolved.planFeatures.allowSessions,
        },
        sampling: {
            ...remote.sampling,
            traces: resolved.samplingRate,
            requests: resolved.samplingRate,
            // The legacy rate only ever governed performance data; errors and
            // replays were all-or-nothing via their enable flags.
            errors: 1,
            profiles: resolved.samplingRate,
            replays: 1,
        },
    };
    const diff = diffConfigs(remote, candidate);
    return diff.transportChanged || diff.killswitchesChanged || diff.featuresChanged || diff.samplingChanged
        ? candidate
        : null;
}
/**
 * Derive per-route ingest URLs from a single endpoint (the legacy init
 * handshake's `ingestUrl`). Baked-in defaults ship empty route URLs; this
 * fills every unconfigured route with the given endpoint. RouteRegistry's
 * forcePath() rewrites the path per route, so one base endpoint is enough.
 *
 * Returns null when every route already has a URL (nothing to bridge).
 */
function deriveTransportFromIngestUrl(transport, ingestUrl) {
    if (!ingestUrl)
        return null;
    let missing = 0;
    const routes = {};
    for (const [name, route] of Object.entries(transport.routes)) {
        if (route.url) {
            routes[name] = route;
        }
        else {
            routes[name] = { ...route, url: ingestUrl };
            missing += 1;
        }
    }
    if (missing === 0)
        return null;
    return {
        ...transport,
        routes: routes,
    };
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
    const transportRouter = TransportRouter.getInstance();
    if (transportRouter) {
        // Same fallback derivation as the main init path: the control-plane
        // modules were built from baked-in defaults (placeholder URLs, features
        // off, sampling 0, transport killed), so point them at the fallback
        // config before draining the queue — otherwise every buffered event
        // would be silently dropped.
        const currentRemote = ConfigManager.getInstance()?.getConfig();
        const bridgedConfig = currentRemote
            ? deriveFallbackRemoteConfig(currentRemote, resolvedConfig)
            : null;
        if (currentRemote && bridgedConfig) {
            const bridgeDiff = diffConfigs(currentRemote, bridgedConfig);
            if (bridgeDiff.transportChanged) {
                transportRouter.handleConfigChange(bridgeDiff, bridgedConfig);
            }
            if (bridgeDiff.killswitchesChanged) {
                void KillswitchEngine.getInstance()?.handleConfigChange(bridgeDiff, bridgedConfig);
            }
            if (bridgeDiff.samplingChanged) {
                SamplingEngine.getInstance()?.handleConfigChange(bridgeDiff, bridgedConfig);
            }
            if (bridgeDiff.featuresChanged) {
                void FeatureController.getInstance()?.handleConfigChange(bridgeDiff, bridgedConfig);
            }
        }
        for (const event of eventQueue.drainAll()) {
            transportRouter.send(event);
        }
    }
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
