/**
 * ConfigManager — the single source of truth for SDK configuration.
 *
 * Architecture:
 * - On init(), fetches remote config with a 3-second timeout race.
 * - If fetch fails and no cache, uses SAFE_DEFAULTS (all features off, sampling 0, transport disabled).
 * - Config merge priority: Baked-in SDK defaults → Remote Config → User init() options (last wins).
 * - Background refresh loop at cache.ttlSeconds interval.
 * - Atomic config reads via getConfig() returning frozen snapshot.
 * - staleWhileRevalidate: serves last known config while fetching new one in background.
 *
 * Thread safety: All config reads return immutable snapshots. Refresh swaps the reference atomically
 * via a single assignment — no concurrent mutation is possible.
 */

import { SDK_VERSION, SDK_NAME } from '../constants/version.js'
import {
  BAKED_IN_REMOTE_CONFIG,
  CONFIG_FETCH_TIMEOUT_MS,
  CONFIG_RETRY_INTERVAL_MS,
  SAFETY_CEILINGS,
  SAFETY_FLOORS,
} from '../constants/defaults.js'
import { REMOTE_CONFIG_SCHEMA_VERSION } from '../types/config.js'
import type { RemoteConfigResponse, SDKInitOptions, ConfigDiff } from '../types/config.js'
import { diffConfigs } from './config-differ.js'
import { validateRemoteConfig } from './config-validator.js'
import { getLogger } from '../utils/logger.js'
import { context as otelContext } from '@opentelemetry/api'
import { suppressTracing } from '@opentelemetry/core'

/**
 * Bootstrap state machine. Subsystems can read this to decide whether
 * they're allowed to emit telemetry (and which "reason" to attribute to
 * any drops). Transitions are monotonic forward — once we've seen a real
 * config, we don't go back to `pending` even if a later refresh fails
 * (we keep the last known-good config thanks to staleWhileRevalidate).
 */
export enum ConfigState {
  /** init() has not run, or no config URL was configured. */
  Pending = 'pending',
  /** init() ran but fetch failed/invalid; SDK is on baked-in safe defaults. */
  SafeDefaults = 'safe_defaults',
  /** A valid remote config is live. */
  Live = 'live',
}

// ─── Local helpers ──────────────────────────────────────────────────────────

function clampMax(value: number | undefined, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ceiling
  return Math.min(Math.max(0, value), ceiling)
}

function clampRange(value: number | undefined, floor: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return floor
  return Math.min(Math.max(floor, value), ceiling)
}

/**
 * Coerce any backend-supplied sampling rate to a valid probability in
 * [0, 1]. Non-numeric or NaN values become 0 (drop everything) so a
 * config typo defaults to "no telemetry" rather than "all telemetry".
 */
function clampProbability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

type ConfigChangeListener = (diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>) => void

export class ConfigManager {
  private static instance: ConfigManager | null = null

  /** Current frozen config snapshot — swapped atomically on refresh. */
  private currentConfig: Readonly<RemoteConfigResponse>
  private initOptions: SDKInitOptions | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: Set<ConfigChangeListener> = new Set()
  private configUrl: string = ''
  private lastFetchSuccess: boolean = false
  private lastFetchAt: number = 0
  private isRefreshing: boolean = false
  private destroyed: boolean = false
  /**
   * Bootstrap state. Starts at `Pending`; transitions to `SafeDefaults`
   * after `initialize()` runs without a successful fetch, or to `Live` once
   * a valid remote config has been merged in.
   */
  private state: ConfigState = ConfigState.Pending

  private constructor() {
    this.currentConfig = BAKED_IN_REMOTE_CONFIG
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager()
    }
    return ConfigManager.instance
  }

  /**
   * Whether this instance has been destroyed.
   * Exposed for shutdown/reinit tests and for guard logic in long-running tasks.
   */
  isDestroyed(): boolean {
    return this.destroyed
  }

  /**
   * Bootstrap state. Subsystems read this so a "no remote config yet" gate
   * can produce a specific drop reason (`config_not_loaded`) instead of a
   * generic feature-off. Monotonic forward — once we've reached `Live` we
   * stay there even across failed refreshes (we keep stale config).
   */
  getState(): ConfigState {
    return this.state
  }

  /** Whether the manager has at least one successful remote fetch. */
  isLive(): boolean {
    return this.state === ConfigState.Live
  }

  // ─── Initialization ───────────────────────────────────────────────────────

  /**
   * Initialize the config manager.
   * Fetches remote config with a 3-second timeout. If fetch fails, uses safe defaults.
   * Returns the resolved config.
   */
  async initialize(options: SDKInitOptions): Promise<Readonly<RemoteConfigResponse>> {
    const logger = getLogger()
    this.initOptions = options
    this.configUrl = options.configUrl ?? (options.baseUrl ? `${options.baseUrl}/v1/sdk-config` : '')

    if (!this.configUrl) {
      logger.warn('ConfigManager: No config URL configured, using baked-in defaults')
      this.currentConfig = this.applyUserOverrides(BAKED_IN_REMOTE_CONFIG, options)
      this.state = ConfigState.SafeDefaults
      return this.currentConfig
    }

    try {
      // Race fetch against 3-second timeout
      const remoteConfig = await Promise.race<RemoteConfigResponse | null>([
        this.fetchConfig(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Config fetch timeout (3000ms)')), CONFIG_FETCH_TIMEOUT_MS)
        ),
      ])

      if (remoteConfig) {
        const merged = this.mergeConfigs(BAKED_IN_REMOTE_CONFIG, remoteConfig, options)
        this.currentConfig = this.freezeDeep(merged)
        this.lastFetchSuccess = true
        this.lastFetchAt = Date.now()
        this.state = ConfigState.Live
        logger.info('ConfigManager: Remote config loaded successfully')
      } else {
        // fetchConfig returned null (e.g. fetch hook not invoked) — treat
        // as a silent failure and stay on safe defaults.
        this.currentConfig = this.applyUserOverrides(BAKED_IN_REMOTE_CONFIG, options)
        this.state = ConfigState.SafeDefaults
        this.scheduleRetry()
      }
    } catch (err) {
      logger.warn(
        `ConfigManager: Failed to fetch remote config: ${err instanceof Error ? err.message : String(err)}`
      )
      logger.warn('ConfigManager: Using baked-in safe defaults. Will retry in background.')
      this.currentConfig = this.applyUserOverrides(BAKED_IN_REMOTE_CONFIG, options)
      this.state = ConfigState.SafeDefaults
      this.scheduleRetry()
    }

    return this.currentConfig
  }

  // ─── Config Access ────────────────────────────────────────────────────────

  /**
   * Get the current config snapshot. Always returns a frozen object.
   * Safe to call from any async context — the snapshot is immutable.
   */
  getConfig(): Readonly<RemoteConfigResponse> {
    return this.currentConfig
  }

  // ─── Change Listeners ─────────────────────────────────────────────────────

  /**
   * Register a listener for config changes during refresh.
   * Returns an unsubscribe function.
   */
  onConfigChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ─── Refresh Loop ─────────────────────────────────────────────────────────

  /**
   * Start the background config refresh loop.
   * Interval is determined by runtime.configTtlSeconds from the current config.
   */
  startRefreshLoop(): void {
    if (this.refreshTimer || this.destroyed) return

    const ttlMs = (this.currentConfig.runtime?.configTtlSeconds ?? 300) * 1000
    this.refreshTimer = setInterval(() => {
      void this.refreshConfig()
    }, ttlMs)

    // Don't keep the process alive just for config refresh
    if (this.refreshTimer && typeof this.refreshTimer === 'object' && 'unref' in this.refreshTimer) {
      ;(this.refreshTimer as NodeJS.Timeout).unref()
    }

    getLogger().info(`ConfigManager: Refresh loop started (interval: ${ttlMs}ms)`)
  }

  /**
   * Stop the background refresh loop and any pending retry timers.
   */
  stopRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /**
   * Refresh config from the backend.
   * If staleWhileRevalidate, serves old config while fetching.
   * Never throws — errors are logged and swallowed.
   */
  async refreshConfig(): Promise<void> {
    if (this.isRefreshing || this.destroyed || !this.configUrl) return

    const logger = getLogger()
    this.isRefreshing = true

    try {
      const newRemoteConfig = await this.fetchConfig()
      // Re-check destroyed state after the network round-trip — the SDK may
      // have shut down while the request was in flight. Applying the new
      // config to a destroyed manager would race against re-init.
      if (!newRemoteConfig || this.destroyed) return

      const oldConfig = this.currentConfig
      const merged = this.mergeConfigs(
        BAKED_IN_REMOTE_CONFIG,
        newRemoteConfig,
        this.initOptions ?? ({} as SDKInitOptions)
      )
      const frozen = this.freezeDeep(merged)

      // Diff old vs new
      const diff = diffConfigs(oldConfig, frozen)

      // Atomic swap
      this.currentConfig = frozen
      this.lastFetchSuccess = true
      this.lastFetchAt = Date.now()
      // Background refreshes can promote a SafeDefaults state to Live the
      // first time the backend becomes reachable post-init.
      this.state = ConfigState.Live

      // Notify listeners if anything meaningful changed
      const hasChanges =
        diff.featuresChanged ||
        diff.killswitchesChanged ||
        diff.samplingChanged ||
        diff.transportChanged ||
        diff.privacyChanged ||
        diff.limitsChanged ||
        diff.instrumentationChanged ||
        diff.runtimeChanged ||
        diff.entitlementsChanged

      if (hasChanges && !this.destroyed) {
        // Snapshot listeners to a stable array — destroy() during dispatch
        // must not mutate the iterator, and unsubscribe() during a listener
        // call must not skip subsequent listeners.
        const snapshot = [...this.listeners]
        logger.info(`ConfigManager: Config changed, notifying ${snapshot.length} listener(s)`)
        for (const listener of snapshot) {
          if (this.destroyed) break
          try {
            listener(diff, frozen)
          } catch (listenerErr) {
            logger.error(
              `ConfigManager: Listener error: ${listenerErr instanceof Error ? listenerErr.message : String(listenerErr)}`
            )
          }
        }
      }
    } catch (err) {
      logger.warn(`ConfigManager: Refresh failed: ${err instanceof Error ? err.message : String(err)}`)

      if (!this.currentConfig.runtime?.staleWhileRevalidate) {
        // staleWhileRevalidate=false means "if a refresh fails, do not
        // continue serving the old config". Reset to baked-in defaults
        // (with user overrides) and notify any listeners so subsystems
        // can react. Previously the SDK only logged here and silently
        // continued using the stale config, which made the flag a no-op.
        logger.warn('ConfigManager: staleWhileRevalidate is off — resetting to baked-in defaults')
        const oldConfig = this.currentConfig
        const fresh = this.applyUserOverrides(BAKED_IN_REMOTE_CONFIG, this.initOptions ?? ({} as SDKInitOptions))
        const diff = diffConfigs(oldConfig, fresh)
        this.currentConfig = fresh
        this.state = ConfigState.SafeDefaults
        // Notify listeners exactly like a normal refresh would.
        const snapshot = [...this.listeners]
        for (const listener of snapshot) {
          if (this.destroyed) break
          try {
            listener(diff, fresh)
          } catch (listenerErr) {
            logger.error(
              `ConfigManager: Listener error during stale-fallback: ${listenerErr instanceof Error ? listenerErr.message : String(listenerErr)}`,
            )
          }
        }
      }
      // Otherwise: keep using stale config (staleWhileRevalidate behavior)
    } finally {
      this.isRefreshing = false
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Destroy the config manager. Idempotent: stops timers, clears listeners,
   * and detaches the singleton so the next getInstance() call yields a fresh
   * instance with no carry-over state.
   */
  destroy(): void {
    // Idempotent: a second destroy() must be a no-op, but still ensure the
    // singleton pointer is cleared in case it was rebuilt by accident.
    if (this.destroyed) {
      if (ConfigManager.instance === this) {
        ConfigManager.instance = null
      }
      return
    }

    this.destroyed = true
    this.stopRefreshLoop()
    this.listeners.clear()
    this.initOptions = null
    this.configUrl = ''
    this.state = ConfigState.Pending

    // Only null the singleton pointer if it still points to this instance —
    // otherwise we'd clobber a freshly-created instance from a concurrent
    // init() call that already ran past getInstance().
    if (ConfigManager.instance === this) {
      ConfigManager.instance = null
    }
  }

  /**
   * Reset the singleton (for testing and reinit).
   * Always returns synchronously — pending background fetches are abandoned
   * via the destroyed flag rather than awaited.
   */
  static reset(): void {
    if (ConfigManager.instance) {
      ConfigManager.instance.destroy()
    }
    ConfigManager.instance = null
  }

  // ─── Private: Fetch ───────────────────────────────────────────────────────

  /**
   * Fetch remote config from POST /v1/sdk-config.
   *
   * Two layers of defense beyond the network call:
   *   1. Schema-version gate — refuse configs newer than this SDK understands.
   *   2. Shape validation — refuse malformed/empty/wrong-typed payloads.
   *
   * The request body advertises which schema version the SDK supports so
   * the backend can downgrade the response if it has multiple wire formats
   * to choose from.
   */
  private async fetchConfig(): Promise<RemoteConfigResponse | null> {
    if (!this.configUrl) return null

    const body = JSON.stringify({
      sdkVersion: SDK_VERSION,
      sdkName: SDK_NAME,
      schemaVersion: REMOTE_CONFIG_SCHEMA_VERSION,
      service: this.initOptions?.service ?? 'unknown-service',
      environment: this.initOptions?.environment ?? 'production',
      runtime: 'node',
      runtimeVersion: process.version,
      capabilities: this.detectCapabilities(),
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS)

    try {
      // Wrap in suppressTracing so the SDK's own config-fetch never produces
      // a span that downstream user code might pick up (and also avoids any
      // self-instrumentation feedback if HttpInstrumentation's ignore hook
      // is misconfigured).
      const response = await otelContext.with(
        suppressTracing(otelContext.active()),
        () =>
          fetch(this.configUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-SDK-Version': SDK_VERSION,
              'X-SDK-Name': SDK_NAME,
              ...(this.initOptions?.apiKey ? { Authorization: `Bearer ${this.initOptions.apiKey}` } : {}),
            },
            body,
            signal: controller.signal,
          }),
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      // Tolerate malformed JSON without throwing the wrong message — surface
      // the original parse error wrapped so callers can tell apart "network
      // failed" vs "backend returned garbage".
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch (parseErr) {
        throw new Error(
          `Remote config response was not valid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        )
      }

      // Shape validation. Catches: null/array/wrong-typed sections,
      // missing required fields, schemaVersion newer than supported,
      // wrong-typed feature/killswitch/sampling values.
      const validation = validateRemoteConfig(parsed)
      if (!validation.valid) {
        throw new Error(
          `Remote config validation failed: ${validation.errors.slice(0, 5).join('; ')}${validation.errors.length > 5 ? ` (+${validation.errors.length - 5} more)` : ''}`,
        )
      }

      return parsed as RemoteConfigResponse
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Detect SDK capabilities (feature strings the binary supports).
   * The backend uses this list to know what knobs to send in the response.
   */
  private detectCapabilities(): string[] {
    return [
      'tracing',
      'requestCapture',
      'errors',
      'metrics',
      'logging',
      'profiling',
      'crons',
      'sessionReplay',
      'runtimeMetrics',
      'eventLoopMonitoring',
      'gcMonitoring',
    ]
  }

  // ─── Private: Merge ───────────────────────────────────────────────────────

  /**
   * Deep merge configs: base → remote → user overrides (last wins).
   * After merging, applies safety ceilings/floors so backend mistakes
   * cannot exceed sane SDK-side limits.
   */
  private mergeConfigs(
    base: Readonly<RemoteConfigResponse>,
    remote: RemoteConfigResponse,
    options: SDKInitOptions
  ): RemoteConfigResponse {
    const merged = structuredClone(base) as Record<string, unknown>

    // Apply remote config (deep merge)
    this.deepMerge(merged, remote as unknown as Record<string, unknown>)

    // Apply user overrides from init options
    const userOverrides = this.buildUserOverrides(options)
    if (userOverrides) {
      this.deepMerge(merged, userOverrides as unknown as Record<string, unknown>)
    }

    return this.applySafetyClamps(merged as unknown as RemoteConfigResponse)
  }

  /**
   * Apply hard safety ceilings (and a couple of floors) to numeric fields
   * the backend can set. The SDK never trusts a remote value above these
   * bounds — a typo'd config that says `maxQueueSize: 1e9` would otherwise
   * happily try to allocate enough memory to OOM the host.
   *
   * Also performs a no-op when `applyOverridesOnly` is true and the merged
   * config is already a baked-in / safe-defaults snapshot. The clamps are
   * idempotent so it's always safe to run them, but skipping the work
   * during init when no remote config arrived saves a few ms.
   */
  private applySafetyClamps(config: RemoteConfigResponse): RemoteConfigResponse {
    const c = config as unknown as Record<string, unknown>

    // limits — clamp every numeric field.
    const limits = (c['limits'] ?? {}) as Record<string, number>
    c['limits'] = {
      ...limits,
      maxSpansPerTrace: clampMax(limits['maxSpansPerTrace'], SAFETY_CEILINGS.maxSpansPerTrace),
      maxSpanAttributes: clampMax(limits['maxSpanAttributes'], SAFETY_CEILINGS.maxSpanAttributes),
      maxAttributeLength: clampMax(limits['maxAttributeLength'], SAFETY_CEILINGS.maxAttributeLength),
      maxPayloadSize: clampMax(limits['maxPayloadSize'], SAFETY_CEILINGS.maxPayloadSize),
      maxQueueSize: clampMax(limits['maxQueueSize'], SAFETY_CEILINGS.maxQueueSize),
      maxMemoryMb: clampMax(limits['maxMemoryMb'], SAFETY_CEILINGS.maxMemoryMb),
      maxCpuOverheadPercent: clampMax(limits['maxCpuOverheadPercent'], SAFETY_CEILINGS.maxCpuOverheadPercent),
    }

    // runtime — clamp ttl and floor it so refresh never hammers the backend.
    const runtime = (c['runtime'] ?? {}) as Record<string, unknown>
    const ttl = runtime['configTtlSeconds']
    if (typeof ttl === 'number') {
      runtime['configTtlSeconds'] = clampRange(ttl, SAFETY_FLOORS.configTtlSeconds, SAFETY_CEILINGS.configTtlSeconds)
    }
    c['runtime'] = runtime

    // transport routes — clamp per-route batch/timeout/flush values.
    const transport = (c['transport'] ?? {}) as Record<string, unknown>
    const routes = (transport['routes'] ?? {}) as Record<string, Record<string, unknown>>
    for (const [name, route] of Object.entries(routes)) {
      const r = route as Record<string, unknown>
      if (typeof r['batchSize'] === 'number') {
        r['batchSize'] = clampMax(r['batchSize'] as number, SAFETY_CEILINGS.batchSize)
      }
      if (typeof r['flushIntervalMs'] === 'number') {
        r['flushIntervalMs'] = clampRange(
          r['flushIntervalMs'] as number,
          SAFETY_FLOORS.flushIntervalMs,
          SAFETY_CEILINGS.flushIntervalMs,
        )
      }
      if (typeof r['timeoutMs'] === 'number') {
        r['timeoutMs'] = clampRange(
          r['timeoutMs'] as number,
          SAFETY_FLOORS.timeoutMs,
          SAFETY_CEILINGS.timeoutMs,
        )
      }
      routes[name] = r
    }
    transport['routes'] = routes

    const retry = (transport['retry'] ?? {}) as Record<string, unknown>
    if (typeof retry['maxRetries'] === 'number') {
      retry['maxRetries'] = clampMax(retry['maxRetries'] as number, SAFETY_CEILINGS.retryMaxRetries)
    }
    if (typeof retry['baseDelayMs'] === 'number') {
      retry['baseDelayMs'] = clampMax(retry['baseDelayMs'] as number, SAFETY_CEILINGS.retryBaseDelayMs)
    }
    transport['retry'] = retry

    c['transport'] = transport

    // sampling — every rate must land in [0, 1]. A backend typo of
    // `traces: 100` (intended "100%") would otherwise enable always-sample
    // because SamplingEngine treats `rate >= 1` as always-sample, but values
    // like NaN, negative, or non-numeric drop everything silently. Clamping
    // at config-merge time guarantees the engine sees only valid rates.
    const sampling = (c['sampling'] ?? {}) as Record<string, unknown>
    const SAMPLING_KEYS = ['traces', 'requests', 'errors', 'profiles', 'replays', 'metrics'] as const
    for (const key of SAMPLING_KEYS) {
      if (key in sampling) {
        sampling[key] = clampProbability(sampling[key])
      }
    }
    const samplingRoutes = (sampling['routes'] ?? {}) as Record<string, Record<string, unknown>>
    for (const [routeName, routeRates] of Object.entries(samplingRoutes)) {
      const r = routeRates as Record<string, unknown>
      for (const key of SAMPLING_KEYS) {
        if (key in r) {
          r[key] = clampProbability(r[key])
        }
      }
      samplingRoutes[routeName] = r
    }
    sampling['routes'] = samplingRoutes
    c['sampling'] = sampling

    return c as unknown as RemoteConfigResponse
  }

  /**
   * Build remote config overrides from user init() options.
   * Maps SDKInitOptions fields to RemoteConfigResponse structure.
   */
  private buildUserOverrides(options: SDKInitOptions): Partial<RemoteConfigResponse> | null {
    const overrides: Record<string, unknown> = {}
    let hasOverrides = false

    // sampleRate is a coarse global override — applies to traces and requests.
    if (options.sampleRate !== undefined) {
      overrides['sampling'] = {
        traces: options.sampleRate,
        requests: options.sampleRate,
      }
      hasOverrides = true
    }

    if (
      options.enableErrors !== undefined ||
      options.enableTracing !== undefined ||
      options.enableMetrics !== undefined ||
      options.enablePerformance !== undefined
    ) {
      overrides['features'] = {
        ...(options.enableErrors !== undefined ? { errors: options.enableErrors } : {}),
        ...(options.enableTracing !== undefined ? { tracing: options.enableTracing } : {}),
        ...(options.enableMetrics !== undefined ? { metrics: options.enableMetrics } : {}),
        ...(options.enablePerformance !== undefined ? { requestCapture: options.enablePerformance } : {}),
      }
      hasOverrides = true
    }

    // dataScrubbing init option maps to privacy.scrubbing. The unified
    // `fields` list takes both header- and body-style sensitive keys —
    // the SecurityScrubber treats them uniformly.
    if (options.dataScrubbing) {
      const headers = options.dataScrubbing.sensitiveHeaders ?? []
      const fields = options.dataScrubbing.sensitiveKeys ?? []
      if (headers.length > 0 || fields.length > 0) {
        overrides['privacy'] = {
          scrubbing: {
            ...(headers.length > 0 ? { headers } : {}),
            ...(fields.length > 0 ? { fields } : {}),
          },
        }
        hasOverrides = true
      }
    }

    if (options.environment) {
      overrides['sdk'] = { environment: options.environment }
      hasOverrides = true
    }

    return hasOverrides ? (overrides as Partial<RemoteConfigResponse>) : null
  }

  /**
   * Apply user overrides to a base config (used when no remote config available).
   */
  private applyUserOverrides(
    base: Readonly<RemoteConfigResponse>,
    options: SDKInitOptions
  ): Readonly<RemoteConfigResponse> {
    const userOverrides = this.buildUserOverrides(options)
    if (!userOverrides) return base

    const merged = structuredClone(base) as Record<string, unknown>
    this.deepMerge(merged, userOverrides as unknown as Record<string, unknown>)
    return this.freezeDeep(this.applySafetyClamps(merged as unknown as RemoteConfigResponse))
  }

  /**
   * Keys that must never be copied during a deep merge — they would
   * mutate the prototype chain of `target` and produce process-wide
   * prototype pollution. `JSON.parse('{"__proto__":{"polluted":true}}')`
   * creates an object whose `__proto__` is an *own property* of the
   * parsed value, so naive iteration via `Object.keys()` enumerates it
   * and `target[key] = source[key]` resolves to the legacy `__proto__`
   * setter that mutates the prototype chain. Skipping these keys is
   * the standard defence and aligns with how other observability SDKs
   * (Sentry, Datadog) merge backend config.
   *
   * `validateRemoteConfig` doesn't catch this because the wire schema
   * permits unknown keys for forward compatibility — defence in depth
   * therefore lives here.
   */
  private static readonly DANGEROUS_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  /**
   * Deep merge source into target. Mutates target.
   * Arrays are replaced, not merged. Objects are recursively merged.
   *
   * Refuses to copy `__proto__`, `constructor`, or `prototype` from the
   * source — see `DANGEROUS_MERGE_KEYS` for the rationale.
   */
  private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of Object.keys(source)) {
      // Defence-in-depth: prototype-pollution keys never propagate, even
      // from a hostile or buggy backend. The legacy `__proto__` setter
      // would mutate Object.prototype process-wide.
      if (ConfigManager.DANGEROUS_MERGE_KEYS.has(key)) continue

      const sourceVal = source[key]
      const targetVal = target[key]

      if (
        sourceVal !== null &&
        typeof sourceVal === 'object' &&
        !Array.isArray(sourceVal) &&
        targetVal !== null &&
        typeof targetVal === 'object' &&
        !Array.isArray(targetVal)
      ) {
        this.deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>)
      } else if (sourceVal !== undefined) {
        target[key] = sourceVal
      }
    }
  }

  /**
   * Deep freeze an object (recursive Object.freeze via structuredClone + freeze).
   */
  private freezeDeep(obj: RemoteConfigResponse): Readonly<RemoteConfigResponse> {
    const clone = structuredClone(obj)
    return this.recursiveFreeze(clone) as Readonly<RemoteConfigResponse>
  }

  private recursiveFreeze(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj
    Object.freeze(obj)
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        this.recursiveFreeze(value)
      }
    }
    return obj
  }

  // ─── Private: Retry ───────────────────────────────────────────────────────

  /**
   * Schedule background retry after initial fetch failure (every 30s).
   */
  private scheduleRetry(): void {
    if (this.retryTimer || this.destroyed) return

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      // The timer may have fired between scheduling and firing — bail if the
      // manager was destroyed in the meantime.
      if (this.destroyed) return
      void (async () => {
        try {
          await this.refreshConfig()
          if (this.destroyed) return
          if (this.lastFetchSuccess) {
            getLogger().info('ConfigManager: Background retry succeeded, starting refresh loop')
            this.startRefreshLoop()
          } else {
            this.scheduleRetry()
          }
        } catch {
          if (!this.destroyed) this.scheduleRetry()
        }
      })()
    }, CONFIG_RETRY_INTERVAL_MS)

    if (this.retryTimer && typeof this.retryTimer === 'object' && 'unref' in this.retryTimer) {
      ;(this.retryTimer as NodeJS.Timeout).unref()
    }
  }
}
