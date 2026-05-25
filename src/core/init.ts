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

import { createHash } from 'crypto'
import type { SDKInitOptions, RemoteConfig, ResolvedSDKConfig, PlanTier, RemoteConfigResponse } from '../types/config.js'
import { sdkInitOptionsSchema } from '../types/config.js'
import { client } from './client.js'
import type { InitResponse } from '../transport/sender.js'
import { sendInitRequest } from '../transport/sender.js'
import { setupGlobalErrorHandlers, resetGlobalErrorHandlers } from '../instrumentation/global-errors.js'
import { eventQueue } from '../transport/queue.js'
import { DEFAULT_BASE_URL, DEFAULT_MAX_PAYLOAD_BYTES, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from '../constants/defaults.js'
import { LOGGING_DEFAULTS, PROFILING_DEFAULTS, TRACING_DEFAULTS } from '../constants/internal-defaults.js'
import { SDKError } from './errors.js'
import { getLogger, setDebugMode, setLogLevel } from '../utils/logger.js'
import { initializePlugins } from '../plugins/index.js'
import { registerSignalHandlers } from './lifecycle.js'
import { processEvent } from './event-pipeline.js'
import { sleep } from '../utils/time.js'
import { initTracer, shutdownTracer } from '../tracing/tracer.js'
import { getSessionManager } from '../session/session-manager.js'
import { resolvePlanFeatures, clampToPlan, getOfflineFallbackPlan } from './plan-gate.js'
import { detectResources } from '../utils/resource-detector.js'
import { errorDeduplicator } from '../processors/deduplicator.js'
import { persistentStorage } from '../storage/persistent-storage.js'
import { sourceMapResolver } from '../processors/source-map-resolver.js'
import { metricsRegistry } from '../metrics/registry.js'
import { otelMetrics } from '../metrics/otel-adapter.js'
import { slowRequestDetector } from '../processors/slow-request-detector.js'
import { registerAutoInstrumentations, resetAutoInstrumentations } from '../instrumentation/auto-instrument.js'
import { costGovernor } from '../utils/cost-governor.js'

// ─── New Remote Config Modules ──────────────────────────────────────────────

import { ConfigManager } from './config-manager.js'
import { VersionPolicy } from './version-policy.js'
import { KillswitchEngine } from './killswitch-engine.js'
import { SamplingEngine } from './sampling-engine.js'
import { FeatureController } from './feature-controller.js'
import { LimitsEngine } from './limits-engine.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { TransportRouter } from '../transport/transport-router.js'
import { LoggingSubsystem } from '../subsystems/logging-subsystem.js'
import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js'
import { CronSubsystem } from '../subsystems/cron-subsystem.js'

const INIT_MAX_ATTEMPTS = 5
const INIT_BASE_RETRY_DELAY_MS = 500
const INIT_MAX_RETRY_DELAY_MS = 5000

/**
 * Initialize the SDK.
 *
 * @param options - SDK configuration options
 * @returns The resolved remote config, or undefined if init failed gracefully
 */
export async function init(options: SDKInitOptions): Promise<Readonly<RemoteConfig> | undefined> {
  // Enable debug mode first so all init logging is visible if requested
  setDebugMode(options.debug ?? false)
  if (options.logLevel) {
    setLogLevel(options.logLevel)
  }

  validateInitOptions(options)

  if (client.initialized) {
    if (!client.hasSameIdentity(options)) {
      throw new SDKError('SDK already initialized with different options', 'SDK_ALREADY_INITIALIZED')
    }
    return client.remoteConfig ?? undefined
  }

  const existingInit = client.getInitPromise()
  if (existingInit) {
    if (!client.hasSamePendingIdentity(options)) {
      throw new SDKError('SDK initialization already in progress with different options', 'SDK_INIT_IN_PROGRESS')
    }
    return existingInit
  }

  client.setPendingIdentity(options)
  const initPromise = initialize(options)
  client.setInitPromise(initPromise)

  try {
    return await initPromise
  } finally {
    client.clearPendingIdentity()
    client.setInitPromise(null)
  }
}

async function initialize(options: SDKInitOptions): Promise<Readonly<RemoteConfig> | undefined> {
  const logger = getLogger()
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/init`

  client.setOptions(options)

  // Initialize breadcrumb buffer
  client.initBreadcrumbs(options.maxBreadcrumbs ?? 100)

  logger.info('SDK init started', {
    baseUrl,
    endpoint,
    service: options.service,
    environment: options.environment,
    release: options.release,
    debug: options.debug ?? false,
  })

  // ─── Phase 1: Remote Config Fetch ───────────────────────────────────────

  const configManager = ConfigManager.getInstance()
  let remoteConfigResponse: Readonly<RemoteConfigResponse> | null = null

  try {
    remoteConfigResponse = await configManager.initialize(options)
    logger.info('Remote config loaded', {
      configHash: remoteConfigResponse.meta.configHash,
      environment: remoteConfigResponse.sdk.environment,
    })
  } catch (err) {
    logger.warn(`Remote config initialization failed: ${err instanceof Error ? err.message : String(err)}`)
    // ConfigManager falls back to BAKED_IN_REMOTE_CONFIG internally
    remoteConfigResponse = configManager.getConfig()
  }

  // ─── Phase 2: Version Policy Enforcement ────────────────────────────────
  //
  // The wire schema no longer carries a `versionPolicy` block — `enforce()`
  // is now a stub that always returns `ok`. Kept as a phase so that if we
  // bring version gating back later, the call site is unchanged.

  const versionResult = VersionPolicy.enforce()

  if (versionResult.status === 'blocked' || versionResult.status === 'force_upgrade') {
    logger.error(`[VersionPolicy] ${versionResult.status}: ${versionResult.message}`)
    client.clear()
    return undefined
  }

  const isDegradedMode = versionResult.status === 'degraded'
  if (isDegradedMode) {
    logger.warn(`[VersionPolicy] Degraded mode: ${versionResult.message}`)
  }

  // ─── Phase 3: Control Plane Initialization ──────────────────────────────

  const killswitchEngine = KillswitchEngine.initialize(remoteConfigResponse.killswitches)

  // Global SDK killswitch — everything becomes no-op
  if (killswitchEngine.isSDKDisabled()) {
    logger.error('[KillswitchEngine] SDK is globally disabled. No telemetry will be captured.')
    client.clear()
    return undefined
  }

  const samplingEngine = SamplingEngine.initialize(remoteConfigResponse.sampling)
  const featureController = FeatureController.initialize(remoteConfigResponse.features)
  const limitsEngine = LimitsEngine.initialize(remoteConfigResponse.limits)
  const securityScrubber = SecurityScrubber.initialize(remoteConfigResponse.privacy)

  if (isDegradedMode) {
    featureController.setDegradedMode(true)
  }

  // ─── Phase 4: Transport Router ──────────────────────────────────────────

  // Awaited so a previous instance fully drains before we send any new event
  // through the new router. Required for warm-start / hot-reload scenarios.
  const transportRouter = await TransportRouter.initialize(remoteConfigResponse.transport, options.apiKey)

  if (killswitchEngine.isKilled('disableTransport')) {
    transportRouter.disable()
  }

  // Register killswitch handler for transport
  killswitchEngine.registerSubsystem('disableTransport', {
    shutdown: () => transportRouter.disable(),
    startup: () => transportRouter.enable(),
  })

  // Wire cost governor from SDK-internal tracing defaults. These knobs no
  // longer come from the wire schema — they're SDK opinions about safe
  // upper bounds for span fan-out and trace duration.
  costGovernor.updateFromConfig({
    maxSpansPerTrace: TRACING_DEFAULTS.maxSpansPerTrace,
    maxTraceDurationMs: TRACING_DEFAULTS.maxTraceDurationMs,
  })

  // ─── Phase 5: Legacy Init Flow (backward compat) ───────────────────────

  for (let attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      logger.debug('SDK init request sending', {
        endpoint,
        attempt,
        maxAttempts: INIT_MAX_ATTEMPTS,
      })

      const response = await sendInitRequest(
        options.apiKey,
        baseUrl,
        DEFAULT_TIMEOUT_MS,
      )

      if (response.success !== true) {
        throw new SDKError('Init response was not successful', 'INIT_REJECTED')
      }

      logger.debug('SDK init response received', {
        endpoint,
        attempt,
        projectId: response.projectId,
        hasConfig: isObject(response.config),
        hasIngestion: isObject(response.ingestion),
      })

      const remoteConfig = validateRemoteConfig(response)
      client.setRemoteConfig(remoteConfig)
      client.setInitResponse(response)

      // Resolve plan features from backend response
      const planTier: PlanTier = remoteConfig.plan ?? 'free'
      const planFeatures = resolvePlanFeatures(planTier, remoteConfig.planFeatures)

      logger.info('Plan resolved', {
        tier: planFeatures.tier,
        allowTracing: planFeatures.allowTracing,
        allowMetrics: planFeatures.allowMetrics,
        allowSessions: planFeatures.allowSessions,
        maxBreadcrumbs: planFeatures.maxBreadcrumbs,
      })

      // Merge user options + remote config → raw resolved config (all features ON)
      const rawConfig = mergeConfig(options, remoteConfig, planFeatures)

      // Attach the full remote config response to the resolved config
      const rawConfigWithRemote = { ...rawConfig, remoteConfig: remoteConfigResponse ?? undefined }

      // Clamp to plan limits — features above plan are forced OFF with warnings
      const resolvedConfig = clampToPlan(rawConfigWithRemote, planFeatures)
      client.setResolvedConfig(resolvedConfig)

      // Configure pre-init buffer and apply feature gates before replaying it into transport.
      eventQueue.configure(resolvedConfig.maxQueueSize)
      filterBufferedEvents(resolvedConfig)

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
      })

      // Validate plugins. Plan-based caps were removed in v3 — every plugin
      // the user passes is now accepted unless the FeatureController later
      // refuses it (still TBD; for now plugins always run).
      let pluginsToInit = options.plugins ?? []
      if (pluginsToInit.length > 0) {
        await initializePlugins(pluginsToInit, resolvedConfig, client.metadata)
      }

      // Register user-provided event processors
      if (options.eventProcessors) {
        for (const processor of options.eventProcessors) {
          client.registerEventProcessor(processor)
        }
      }

      // beforeSend used to be a paid-plan feature; v3 makes it always
      // available. The hook still runs through the event pipeline's
      // BEFORE_SEND_TIMEOUT_MS guard so a slow user hook can't stall the
      // pipeline.

      // Initialize persistent storage and replay persisted events.
      const apiKeyHash = createHash('sha256').update(options.apiKey).digest('hex')
      persistentStorage.configure({ apiKeyHash })
      const persistedEvents = await persistentStorage.init()

      // CRITICAL: replay through `processEvent` (the full pipeline) rather
      // than directly to the transport. Pre-init events were captured
      // before SecurityScrubber, applyScopeToEvent, dedup, plugin processors,
      // beforeSend, sampling, LimitsEngine, and loadShedder were configured.
      // Sending them straight to the wire skipped every PII / governance
      // filter — a request body containing an Authorization header captured
      // pre-init reached the backend unredacted. Routing through processEvent
      // ensures the same filter chain runs as for any post-init event.
      for (const event of persistedEvents) {
        processEvent(event as import('../types/event.js').SDKEvent)
      }
      for (const event of eventQueue.drainAll()) {
        processEvent(event as import('../types/event.js').SDKEvent)
      }

      // Configure source map resolver if options provided
      if (options.sourceMaps) {
        sourceMapResolver.configure({
          sourceMapPaths: options.sourceMaps.paths ? Array.from(options.sourceMaps.paths) : [],
          allowRemoteSourceMaps: options.sourceMaps.allowRemote ?? false,
          embedSourceContent: options.sourceMaps.embedSourceContent ?? false,
        })
      }

      // Configure slow request detector
      slowRequestDetector.configure({})

      setupGlobalErrorHandlers()
      registerSignalHandlers()
      errorDeduplicator.start()
      metricsRegistry.start()
      
      const { apiPayloadScrubber } = await import('../processors/sanitizer.js')
      apiPayloadScrubber.configure(resolvedConfig.dataScrubbing)

      // Detect runtime resources (host, container, cloud metadata)
      const resources = detectResources(client.metadata.sdkVersion)

      // ─── Phase 6: Feature-Controlled Subsystem Registration ───────────

      const eventMetadata = client.metadata

      // Register tracing subsystem
      await featureController.register(
        'tracing',
        () => {
          if (!killswitchEngine.isKilled('disableTracing') && resolvedConfig.enableTracing) {
            initTracer(resolvedConfig, resources)
            registerAutoInstrumentations({}) // Reads from remote config internally
          }
        },
        () => {
          logger.info('[FeatureController] Tracing subsystem stopped')
        }
      )

      killswitchEngine.registerSubsystem('disableTracing', {
        shutdown: async () => {
          // Real teardown: stop the OTel tracer provider AND uninstall the
          // auto-instrumentations so no new spans are produced. A bare log
          // here was a no-op — backend "kill tracing" had no effect.
          logger.warn('[KillswitchEngine] Tracing killed — shutting down tracer + auto-instrumentation')
          try { await shutdownTracer() } catch (err) {
            logger.error('[KillswitchEngine] shutdownTracer failed', { error: err })
          }
          try { resetAutoInstrumentations() } catch (err) {
            logger.error('[KillswitchEngine] resetAutoInstrumentations failed', { error: err })
          }
        },
        startup: () => {
          // Refuse to re-init if tracing is already alive — protects
          // against double-init of NodeTracerProvider when the killswitch
          // toggles rapidly.
          if (featureController.isEnabled('tracing')) {
            initTracer(resolvedConfig, resources)
            registerAutoInstrumentations({})
          }
        },
      })

      // Register metrics subsystem
      await featureController.register(
        'metrics',
        () => {
          if (!killswitchEngine.isKilled('disableMetrics') && resolvedConfig.enableMetrics) {
            otelMetrics.init(
              {
                service: resolvedConfig.service,
                environment: resolvedConfig.environment,
                release: resolvedConfig.release,
              },
              resolvedConfig.otelMetrics,
              resources
            )
          }
        },
        () => {
          logger.info('[FeatureController] Metrics subsystem stopped')
        }
      )

      killswitchEngine.registerSubsystem('disableMetrics', {
        shutdown: async () => {
          logger.warn('[KillswitchEngine] Metrics killed — shutting down OTel meter provider')
          try { await otelMetrics.shutdown() } catch (err) {
            logger.error('[KillswitchEngine] otelMetrics.shutdown failed', { error: err })
          }
        },
        startup: () => {
          if (featureController.isEnabled('metrics')) {
            otelMetrics.init(
              {
                service: resolvedConfig.service,
                environment: resolvedConfig.environment,
                release: resolvedConfig.release,
              },
              resolvedConfig.otelMetrics,
              resources
            )
          }
        },
      })

      // Register errors subsystem
      await featureController.register(
        'errors',
        () => {
          if (!killswitchEngine.isKilled('disableErrors')) {
            setupGlobalErrorHandlers()
          }
        },
        () => {
          logger.info('[FeatureController] Errors subsystem stopped')
        }
      )

      killswitchEngine.registerSubsystem('disableErrors', {
        shutdown: () => {
          // Detach the SDK's process-level uncaughtException /
          // unhandledRejection listeners and unwrap console.error.
          logger.warn('[KillswitchEngine] Errors killed — detaching global error handlers')
          try { resetGlobalErrorHandlers() } catch (err) {
            logger.error('[KillswitchEngine] resetGlobalErrorHandlers failed', { error: err })
          }
        },
        startup: () => {
          if (featureController.isEnabled('errors')) {
            setupGlobalErrorHandlers()
          }
        },
      })

      // Register logging subsystem. The wire schema no longer carries a
      // `logging` block — we synthesize one from SDK-internal defaults and
      // the `features.logging` toggle so the subsystem signature stays
      // unchanged during the migration.
      await featureController.register(
        'logging',
        () => {
          if (!killswitchEngine.isKilled('disableLogs')) {
            const loggingSub = LoggingSubsystem.initialize(
              {
                ...LOGGING_DEFAULTS,
                enabled: remoteConfigResponse!.features.logging,
              },
              (event) => { processEvent(event) },
              eventMetadata
            )
            loggingSub.start()
          }
        },
        () => {
          LoggingSubsystem.reset()
        }
      )

      killswitchEngine.registerSubsystem('disableLogs', {
        shutdown: () => {
          const sub = LoggingSubsystem.getInstance()
          if (sub) sub.stop()
        },
        startup: () => {
          const sub = LoggingSubsystem.getInstance()
          if (sub) sub.start()
        },
      })

      // Register profiling subsystem. Same pattern as logging: synthesize
      // the legacy `ProfilingConfig` shape from SDK-internal defaults plus
      // the remote `features.profiling` flag.
      await featureController.register(
        'profiling',
        async () => {
          if (!killswitchEngine.isKilled('disableProfiling')) {
            const profilingSub = ProfilingSubsystem.initialize(
              {
                ...PROFILING_DEFAULTS,
                enabled: remoteConfigResponse!.features.profiling,
              },
              (event) => { processEvent(event) },
              eventMetadata
            )
            await profilingSub.start()
          }
        },
        async () => {
          const sub = ProfilingSubsystem.getInstance()
          if (sub) await sub.stop()
        }
      )

      killswitchEngine.registerSubsystem('disableProfiling', {
        shutdown: async () => {
          const sub = ProfilingSubsystem.getInstance()
          if (sub) await sub.stop()
        },
        startup: async () => {
          const sub = ProfilingSubsystem.getInstance()
          if (sub) await sub.start()
        },
      })

      // Register crons subsystem
      await featureController.register(
        'crons',
        () => {
          CronSubsystem.initialize(
            (event) => transportRouter.send(event),
            eventMetadata
          )
        },
        () => {
          CronSubsystem.reset()
        }
      )

      // Register session replay subsystem
      await featureController.register(
        'sessionReplay',
        () => {
          if (planFeatures.allowSessions) {
            getSessionManager()
          }
        },
        () => {
          logger.info('[FeatureController] Session replay subsystem stopped')
        }
      )

      // ─── Phase 7: Wire Config Change Listeners ──────────────────────────

      configManager.onConfigChange((diff, newConfig) => {
        logger.info('[ConfigManager] Config changed, propagating to subsystems')

        if (diff.killswitchesChanged) {
          void killswitchEngine.handleConfigChange(diff, newConfig)
        }
        if (diff.samplingChanged) {
          samplingEngine.handleConfigChange(diff, newConfig)
        }
        if (diff.featuresChanged) {
          void featureController.handleConfigChange(diff, newConfig)
          // The logging/profiling subsystems' config is synthesized from
          // `features.*` plus SDK defaults. When `features` flips, push a
          // refreshed shape to whichever subsystem is alive so its `enabled`
          // mirror matches the new feature flag.
          const loggingSub = LoggingSubsystem.getInstance()
          if (loggingSub) {
            loggingSub.handleConfigChange(diff, {
              ...newConfig,
              logging: { ...LOGGING_DEFAULTS, enabled: newConfig.features.logging },
            } as unknown as Readonly<RemoteConfigResponse>)
          }
          const profilingSub = ProfilingSubsystem.getInstance()
          if (profilingSub) {
            profilingSub.handleConfigChange(diff, {
              ...newConfig,
              profiling: { ...PROFILING_DEFAULTS, enabled: newConfig.features.profiling },
            } as unknown as Readonly<RemoteConfigResponse>)
          }
        }
        if (diff.limitsChanged) {
          limitsEngine.handleConfigChange(diff, newConfig)
        }
        if (diff.privacyChanged) {
          securityScrubber.handleConfigChange(diff, newConfig)
        }
        if (diff.transportChanged) {
          transportRouter.handleConfigChange(diff, newConfig)
        }
      })

      // ─── Phase 8: Start Config Refresh Loop ────────────────────────────

      configManager.startRefreshLoop()

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
      })

      return remoteConfig
    } catch (error) {
      client.clearConfig()

      if (!isRetryableInitError(error)) {
        client.clear()
        logger.error(
          'SDK initialization failed with a non-retryable error; host application will continue without SDK telemetry',
          { error, endpoint, attempt, maxAttempts: INIT_MAX_ATTEMPTS }
        )
        return undefined
      }

      if (attempt >= INIT_MAX_ATTEMPTS) {
        const fallbackConfig = initializeOfflineFallback(options, baseUrl, logger)
        logger.error(
          'SDK initialization failed after retry budget exhausted; using offline fallback telemetry config',
          { error, endpoint, attempt, maxAttempts: INIT_MAX_ATTEMPTS }
        )
        return fallbackConfig
      }

      const nextRetryDelayMs = retryDelayMs(attempt)
      logger.warn('SDK init attempt failed; retrying', {
        error,
        endpoint,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: INIT_MAX_ATTEMPTS,
        nextRetryDelayMs,
      })
      await sleep(nextRetryDelayMs)
    }
  }
}

// ─── Config Resolution ──────────────────────────────────────────────────────

/**
 * Merge user options + remote config into ResolvedSDKConfig.
 * ALL features default to ON (true) — plan clamping happens after this.
 */
function mergeConfig(
  options: SDKInitOptions,
  remote: RemoteConfig,
  planFeatures: import('../types/config.js').PlanFeatures,
): ResolvedSDKConfig {
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
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateInitOptions(options: SDKInitOptions): void {
  const result = sdkInitOptionsSchema.safeParse(options)

  if (!result.success) {
    const issues = result.error.issues.map(
      issue => `${issue.path.join('.')}: ${issue.message}`
    )
    throw new SDKError(
      `Invalid SDK init options: ${issues.join('; ')}`,
      'INVALID_INIT_OPTIONS',
      { issues }
    )
  }
}

function resolveBaseUrl(userBaseUrl?: string): string {
  const baseUrl = userBaseUrl ?? DEFAULT_BASE_URL
  if (!baseUrl) {
    throw new SDKError('SDK_BASE_URL is required', 'MISSING_BASE_URL')
  }
  validateUrl(baseUrl, 'baseUrl')
  return baseUrl
}

function validateRemoteConfig(response: InitResponse): RemoteConfig {
  const config = isObject(response.config) ? response.config : null
  const ingestion = isObject(response.ingestion) ? response.ingestion : null

  if (!config) {
    throw new SDKError('Init config is missing or invalid', 'INVALID_INIT_CONFIG')
  }

  const ingestUrl = stringField(config, ['ingestUrl', 'ingestURL', 'apiEndpoint'])
    ?? stringField(ingestion, ['endpoint', 'ingestUrl', 'apiEndpoint'])

  if (!ingestUrl) {
    throw new SDKError('Init config missing ingestUrl', 'INVALID_INIT_CONFIG')
  }

  validateUrl(ingestUrl, 'ingestUrl')

  return {
    ingestUrl,
    samplingRate: requiredNumberField(config['samplingRate'], 'samplingRate', 0, 1),
    enableErrors: requiredBooleanField(config['enableErrors'], 'enableErrors'),
    enablePerformance: requiredBooleanField(config['enablePerformance'], 'enablePerformance'),
    maxQueueSize: requiredIntField(
      ingestion?.['maxQueueSize'] ?? ingestion?.['queueSizeLimit'],
      'maxQueueSize',
      1
    ),
    batchSize: requiredIntField(ingestion?.['batchSize'], 'batchSize', 1),
    flushIntervalMs: requiredIntField(
      ingestion?.['flushInterval'] ?? ingestion?.['flushIntervalMs'],
      'flushIntervalMs',
      1
    ),
    maxRetries: optionalIntField(config['maxRetries'], 'maxRetries', DEFAULT_MAX_RETRIES, 0),
    maxPayloadBytes: optionalIntField(config['maxPayloadBytes'], 'maxPayloadBytes', DEFAULT_MAX_PAYLOAD_BYTES, 1),

    // Plan tier (defaults to 'free' if not provided by backend)
    plan: ((response as unknown as Record<string, unknown>).plan as PlanTier) ?? undefined,
    planFeatures: (response as unknown as Record<string, unknown>).planFeatures as RemoteConfig['planFeatures'] ?? undefined,
  }
}

function filterBufferedEvents(config: ResolvedSDKConfig): void {
  const samplingEngineInstance = SamplingEngine.getInstance()

  eventQueue.filter(event => {
    const e = event as Record<string, unknown>
    if (e['type'] === 'request') {
      if (!config.enablePerformance) return false
      if (config.samplingRate >= 1) return true
      if (config.samplingRate <= 0) return false

      // Deterministic sampling. The engine is initialized in Phase 3 of
      // init() so it's always present when filterBufferedEvents runs;
      // the explicit check is defensive, and falling through means
      // dropping the event rather than non-deterministic Math.random()
      // (which would make sampling decisions inconsistent across nodes).
      if (samplingEngineInstance) {
        const traceId = (e['traceId'] as string) ?? (e['requestId'] as string) ?? String(e['timestamp'])
        const decision = samplingEngineInstance.shouldSampleTrace(traceId)
        return decision.sampled
      }

      // SamplingEngine not yet up — drop rather than sample non-deterministically.
      return false
    }
    if (e['type'] === 'error') {
      return config.enableErrors
    }
    return true
  })
}

// ─── Field Extractors ───────────────────────────────────────────────────────

function stringField(raw: Record<string, unknown> | null, names: string[]): string | null {
  if (!raw) return null
  for (const name of names) {
    const value = raw[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function requiredBooleanField(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SDKError(`Init config field ${fieldName} must be boolean`, 'INVALID_INIT_CONFIG', { fieldName })
  }
  return value
}

function requiredNumberField(value: unknown, fieldName: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SDKError(`Init config field ${fieldName} out of range`, 'INVALID_INIT_CONFIG', {
      fieldName, min, max, value,
    })
  }
  return value
}

function requiredIntField(value: unknown, fieldName: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new SDKError(`Init config field ${fieldName} must be an integer >= ${min}`, 'INVALID_INIT_CONFIG', {
      fieldName, min, value,
    })
  }
  return value
}

function optionalIntField(value: unknown, fieldName: string, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback
  return requiredIntField(value, fieldName, min)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function validateUrl(value: string, fieldName: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Unsupported protocol')
    }
  } catch (error) {
    throw new SDKError(`${fieldName} must be a valid HTTP URL`, 'INVALID_URL', { fieldName }, error)
  }
}

function isRetryableInitError(error: unknown): boolean {
  if (!(error instanceof SDKError)) return false
  if (error.code === 'NETWORK_ERROR') return true

  const status = Number(error.context.statusCode ?? error.context.status)
  return status === 408 || status === 429 || status >= 500
}

function retryDelayMs(attempt: number): number {
  const exponential = Math.min(INIT_MAX_RETRY_DELAY_MS, INIT_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1))
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2))
}

function initializeOfflineFallback(
  options: SDKInitOptions,
  baseUrl: string,
  logger: ReturnType<typeof getLogger>,
): Readonly<RemoteConfig> {
  const planFeatures = getOfflineFallbackPlan()
  const ingestUrl = `${baseUrl.replace(/\/+$/, '')}/v1/events`
  const remoteConfig: RemoteConfig = {
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
  }
  const resolvedConfig = clampToPlan(mergeConfig(options, remoteConfig, planFeatures), planFeatures)

  client.setRemoteConfig(remoteConfig)
  client.setResolvedConfig(resolvedConfig)
  eventQueue.configure(resolvedConfig.maxQueueSize)
  filterBufferedEvents(resolvedConfig)

  if (options.eventProcessors) {
    for (const processor of options.eventProcessors) {
      client.registerEventProcessor(processor)
    }
  }

  const transportRouter = TransportRouter.getInstance()
  if (transportRouter) {
    for (const event of eventQueue.drainAll()) {
      transportRouter.send(event as import('../types/event.js').SDKEvent)
    }
  }
  setupGlobalErrorHandlers()
  registerSignalHandlers()
  errorDeduplicator.start()

  logger.warn('SDK offline fallback initialized', {
    plan: resolvedConfig.plan,
    ingestUrl: resolvedConfig.ingestUrl,
    enableErrors: resolvedConfig.enableErrors,
    enablePerformance: resolvedConfig.enablePerformance,
  })

  return remoteConfig
}
