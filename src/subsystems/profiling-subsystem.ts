/** CPU profiling subsystem driven by the authoritative remote snapshot. */

import type { RemoteConfigResponse } from '../types/config.js'
import type { ProfileEvent, EventMetadata } from '../types/event.js'
import { PROFILING_DEFAULTS } from '../constants/internal-defaults.js'
import { getRequestContext } from '../core/context.js'
import { getLogger } from '../utils/logger.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { EntitlementGate } from '../core/entitlement-gate.js'
import { trace } from '@opentelemetry/api'

type ProfileEmitter = (event: ProfileEvent) => void

interface ProfilingRuntimeConfig {
  readonly enabled: boolean
  readonly cpu: boolean
  readonly heap: boolean
  readonly sampleRate: number
  readonly maxDurationMs: number
  readonly continuous: boolean
  readonly continuousIntervalMs: number
  readonly sampleIntervalMicroseconds: number
  readonly sampleRateHz: number
}

interface ActiveProfile {
  readonly traceId: string
  readonly spanId: string | undefined
  readonly requestId: string | undefined
  readonly profileType: 'cpu' | 'heap'
  readonly startTime: number
  timeoutHandle: ReturnType<typeof setTimeout> | null
}

export class ProfilingSubsystem {
  private static instance: ProfilingSubsystem | null = null

  private config: ProfilingRuntimeConfig
  private readonly emitter: ProfileEmitter
  private metadata: EventMetadata
  private readonly activeProfiles = new Map<string, ActiveProfile>()
  private activeCpuProfileKey: string | null = null
  private inspectorSession: unknown = null
  private inspectorAvailable = false
  private destroyed = false

  // Continuous wall-clock profiling state
  private continuousTimer: ReturnType<typeof setInterval> | null = null
  private continuousChunkStartTime = 0
  private isContinuousRunning = false
  private readonly activeTracesInChunk = new Set<string>()

  private constructor(config: Readonly<RemoteConfigResponse>, emitter: ProfileEmitter, metadata: EventMetadata) {
    this.config = resolveProfilingConfig(config)
    this.emitter = emitter
    this.metadata = metadata
  }

  static initialize(
    config: Readonly<RemoteConfigResponse>,
    emitter: ProfileEmitter,
    metadata: EventMetadata,
  ): ProfilingSubsystem {
    ProfilingSubsystem.instance?.destroy()
    ProfilingSubsystem.instance = new ProfilingSubsystem(config, emitter, metadata)
    return ProfilingSubsystem.instance
  }

  static getInstance(): ProfilingSubsystem | null {
    return ProfilingSubsystem.instance
  }

  updateMetadata(metadata: EventMetadata): void {
    this.metadata = metadata
  }

  async start(): Promise<void> {
    if (this.destroyed || !this.config.enabled) return
    if (this.inspectorAvailable) {
      if (this.config.continuous && this.canProfile('cpu')) {
        await this.startContinuousProfiling()
      }
      return
    }
    const logger = getLogger()
    try {
      let session: { post: (method: string, params?: unknown) => Promise<unknown>; disconnect: () => void } | null = null
      try {
        const inspectorPromises = await import('node:inspector/promises')
        const s = new inspectorPromises.Session()
        s.connect()
        session = s as unknown as { post: (method: string, params?: unknown) => Promise<unknown>; disconnect: () => void }
      } catch {
        const inspector = await import('node:inspector')
        const rawSession = new inspector.Session()
        rawSession.connect()
        session = {
          post: (method: string, params?: unknown) => new Promise((resolve, reject) => {
            if (typeof params === 'object' && params !== null) {
              rawSession.post(method, params as Record<string, unknown>, (err: Error | null, res: unknown) => {
                if (err) reject(err)
                else resolve(res)
              })
            } else {
              rawSession.post(method, (err: Error | null, res: unknown) => {
                if (err) reject(err)
                else resolve(res)
              })
            }
          }),
          disconnect: () => rawSession.disconnect(),
        }
      }

      this.inspectorSession = session
      this.inspectorAvailable = true
      logger.info('[ProfilingSubsystem] Inspector session connected')

      // If continuous wall-clock profiling is enabled by remote config, launch immediately
      if (this.config.continuous && this.canProfile('cpu')) {
        await this.startContinuousProfiling()
      }
    } catch (error) {
      logger.warn('[ProfilingSubsystem] Failed to initialize inspector', { error })
      this.inspectorAvailable = false
    }
  }

  /**
   * Starts continuous wall-clock CPU sampling driven by remote config.
   * Periodically flushes chunked profiles to the backend ingestion queue.
   */
  async startContinuousProfiling(): Promise<boolean> {
    if (this.destroyed || !this.config.enabled || !EntitlementGate.isAllowed('profiling') || !this.inspectorAvailable) {
      return false
    }
    if (this.isContinuousRunning) return true
    const session = this.inspectorSession as { post: (method: string, params?: unknown) => Promise<unknown> } | null
    if (!session) return false

    try {
      await session.post('Profiler.enable')
      if (this.config.sampleIntervalMicroseconds > 0) {
        await session.post('Profiler.setSamplingInterval', { interval: this.config.sampleIntervalMicroseconds })
      }
      await session.post('Profiler.start')
      this.isContinuousRunning = true
      this.continuousChunkStartTime = Date.now()
      this.activeTracesInChunk.clear()

      if (this.continuousTimer) clearInterval(this.continuousTimer)
      this.continuousTimer = setInterval(() => {
        void this.flushContinuousChunk()
      }, this.config.continuousIntervalMs)
      this.continuousTimer.unref?.()

      getLogger().info('[ProfilingSubsystem] Continuous wall-clock CPU profiling started', {
        intervalMs: this.config.continuousIntervalMs,
        sampleRateHz: this.config.sampleRateHz,
      })
      return true
    } catch (error) {
      getLogger().warn('[ProfilingSubsystem] Failed to start continuous CPU profiling', { error })
      this.isContinuousRunning = false
      return false
    }
  }

  /**
   * Stops the current continuous profiling chunk, emits the profile event,
   * and immediately restarts the next chunk.
   */
  async flushContinuousChunk(): Promise<void> {
    if (!this.isContinuousRunning) return
    const session = this.inspectorSession as { post: (method: string, params?: unknown) => Promise<any> } | null
    if (!session) return

    try {
      const result = await session.post('Profiler.stop')
      const endTime = Date.now()
      const chunkDuration = endTime - this.continuousChunkStartTime
      const traceIds = Array.from(this.activeTracesInChunk)
      this.activeTracesInChunk.clear()
      this.continuousChunkStartTime = endTime

      // Immediately restart profiler for the next chunk
      try {
        await session.post('Profiler.start')
      } catch (startErr) {
        getLogger().debug('[ProfilingSubsystem] Failed to restart continuous profiler chunk', { error: startErr })
      }

      const scrubber = SecurityScrubber.getInstance()
      const profile = scrubber ? scrubber.scrubValue(result?.profile) : result?.profile

      const event: ProfileEvent = {
        type: 'profile',
        profileType: 'cpu',
        startTime: endTime - chunkDuration,
        endTime,
        duration: chunkDuration,
        profile,
        timestamp: endTime,
        metadata: this.metadata,
        isContinuous: true,
        sampleRateHz: this.config.sampleRateHz,
        activeTraceIds: traceIds.length > 0 ? traceIds : undefined,
      }
      this.emitter(event)
    } catch (error) {
      if (isNoRecordingProfilesError(error)) {
        getLogger().debug('[ProfilingSubsystem] Continuous chunk was already stopped', { error })
      } else {
        getLogger().warn('[ProfilingSubsystem] Failed to flush continuous CPU profile chunk', { error })
      }
    }
  }

  /**
   * Stops the continuous profiling loop and shuts down the V8 profiler.
   */
  async stopContinuousProfiling(): Promise<void> {
    if (this.continuousTimer) {
      clearInterval(this.continuousTimer)
      this.continuousTimer = null
    }
    if (!this.isContinuousRunning) return

    this.isContinuousRunning = false
    const session = this.inspectorSession as { post: (method: string) => Promise<unknown> } | null
    if (session) {
      try {
        await session.post('Profiler.stop')
      } catch (error) {
        if (!isNoRecordingProfilesError(error)) {
          getLogger().debug('[ProfilingSubsystem] Profiler.stop error during continuous teardown', { error })
        }
      }
    }
    this.activeTracesInChunk.clear()
  }

  /**
   * Correlates an active traceId with the current continuous profiling chunk.
   */
  recordActiveTrace(traceId: string): void {
    if (this.isContinuousRunning && traceId) {
      this.activeTracesInChunk.add(traceId)
    }
  }

  /**
   * Returns whether continuous wall-clock profiling is currently running.
   */
  isContinuousActive(): boolean {
    return this.isContinuousRunning
  }

  /**
   * Returns current continuous profiling configuration.
   */
  getContinuousConfig(): { continuous: boolean; intervalMs: number; sampleRateHz: number } {
    return {
      continuous: this.config.continuous,
      intervalMs: this.config.continuousIntervalMs,
      sampleRateHz: this.config.sampleRateHz,
    }
  }

  async startCpuProfile(traceId?: string, spanId?: string): Promise<boolean> {
    if (!this.canProfile('cpu')) return false
    const session = this.inspectorSession as { post: (method: string) => Promise<void> } | null
    if (!session) return false

    const activeSpan = trace.getActiveSpan()
    const activeSpanContext = activeSpan?.spanContext()
    const resolvedTraceId = traceId ?? activeSpanContext?.traceId
    if (!resolvedTraceId || !this.shouldProfile(resolvedTraceId)) return false

    const resolvedSpanId = spanId ?? activeSpanContext?.spanId
    const requestId = getRequestContext()?.requestId
    const key = `cpu:${resolvedTraceId}`
    if (this.activeCpuProfileKey !== null) return false
    if (this.activeProfiles.has(key)) return false

    // If continuous profiling is active, record the trace association and let continuous profiling track it
    if (this.isContinuousRunning) {
      this.recordActiveTrace(resolvedTraceId)
      activeSpan?.addEvent('pulse.profile.continuous', { 'profile.type': 'cpu', 'profile.id': key })
      activeSpan?.setAttribute('pulse.profile.active', true)
      activeSpan?.setAttribute('pulse.profile.continuous', true)
      return true
    }

    try {
      await session.post('Profiler.enable')
      await session.post('Profiler.start')
      this.activeCpuProfileKey = key
      const startTime = Date.now()
      const timeoutHandle = setTimeout(() => void this.stopCpuProfile(resolvedTraceId), this.config.maxDurationMs)
      timeoutHandle.unref?.()

      this.activeProfiles.set(key, {
        traceId: resolvedTraceId,
        spanId: resolvedSpanId,
        requestId,
        profileType: 'cpu',
        startTime,
        timeoutHandle,
      })
      activeSpan?.addEvent('pulse.profile.start', { 'profile.type': 'cpu', 'profile.id': key })
      activeSpan?.setAttribute('pulse.profile.active', true)
      return true
    } catch (error) {
      getLogger().warn('[ProfilingSubsystem] Failed to start CPU profile', { error })
      return false
    }
  }

  async stopCpuProfile(traceId: string): Promise<void> {
    const key = `cpu:${traceId}`
    const active = this.activeProfiles.get(key)
    if (!active) return
    if (this.activeCpuProfileKey !== key) return

    this.activeProfiles.delete(key)
    if (active.timeoutHandle) clearTimeout(active.timeoutHandle)
    const session = this.inspectorSession as { post: (method: string) => Promise<{ profile: unknown }> } | null
    if (!session) {
      this.activeCpuProfileKey = null
      return
    }

    try {
      const result = await session.post('Profiler.stop')
      const endTime = Date.now()
      const scrubber = SecurityScrubber.getInstance()
      const profile = scrubber ? scrubber.scrubValue(result.profile) : result.profile
      const event: ProfileEvent = {
        type: 'profile',
        profileType: 'cpu',
        traceId: active.traceId,
        spanId: active.spanId,
        requestId: active.requestId,
        startTime: active.startTime,
        endTime,
        duration: endTime - active.startTime,
        profile,
        timestamp: endTime,
        metadata: this.metadata,
      }
      this.emitter(event)

      const activeSpan = trace.getActiveSpan()
      if (activeSpan?.spanContext().traceId === active.traceId) {
        activeSpan.addEvent('pulse.profile.stop', {
          'profile.type': 'cpu',
          'profile.duration_ms': endTime - active.startTime,
        })
        activeSpan.setAttribute('pulse.profile.active', false)
      }
    } catch (error) {
      const logger = getLogger()
      if (isNoRecordingProfilesError(error)) {
        logger.debug('[ProfilingSubsystem] CPU profile was already stopped', { error })
      } else {
        logger.warn('[ProfilingSubsystem] Failed to stop CPU profile', { error })
      }
    } finally {
      this.activeCpuProfileKey = null
    }
  }

  /** Apply a validated complete snapshot selected by ConfigManager. */
  handleConfigChange(config: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return
    const prevContinuous = this.config.continuous
    const prevInterval = this.config.continuousIntervalMs
    this.config = resolveProfilingConfig(config)

    // Dynamic continuous profiling transition driven by remote config
    if (!prevContinuous && this.config.continuous) {
      if (this.inspectorAvailable && this.canProfile('cpu')) {
        void this.startContinuousProfiling()
      }
    } else if (prevContinuous && !this.config.continuous) {
      void this.stopContinuousProfiling()
    } else if (this.isContinuousRunning && prevInterval !== this.config.continuousIntervalMs) {
      // Re-arm timer with updated interval from remote config
      if (this.continuousTimer) clearInterval(this.continuousTimer)
      this.continuousTimer = setInterval(() => {
        void this.flushContinuousChunk()
      }, this.config.continuousIntervalMs)
      this.continuousTimer.unref?.()
    }
  }

  async stop(): Promise<void> {
    await this.stopContinuousProfiling()

    for (const active of this.activeProfiles.values()) {
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle)
    }
    this.activeProfiles.clear()
    this.activeCpuProfileKey = null

    if (this.inspectorSession && this.inspectorAvailable) {
      try {
        ;(this.inspectorSession as { disconnect: () => void }).disconnect()
      } catch {
        // Best-effort teardown.
      }
    }
    this.inspectorSession = null
    this.inspectorAvailable = false
    getLogger().info('[ProfilingSubsystem] Stopped')
  }

  private canProfile(type: 'cpu' | 'heap'): boolean {
    if (this.destroyed || !this.config.enabled || !EntitlementGate.isAllowed('profiling') || !this.inspectorAvailable) return false
    return type === 'cpu' ? this.config.cpu : this.config.heap
  }

  private shouldProfile(traceId: string): boolean {
    if (this.config.sampleRate >= 1) return true
    if (this.config.sampleRate <= 0) return false
    let hash = 2166136261
    for (let index = 0; index < traceId.length; index++) {
      hash ^= traceId.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0) / 0x100000000 < this.config.sampleRate
  }

  destroy(): void {
    void this.stop()
    this.destroyed = true
    if (ProfilingSubsystem.instance === this) ProfilingSubsystem.instance = null
  }

  static reset(): void {
    ProfilingSubsystem.instance?.destroy()
  }
}

function isNoRecordingProfilesError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('No recording profiles found')
}

function resolveProfilingConfig(config: Readonly<RemoteConfigResponse>): ProfilingRuntimeConfig {
  const continuous = Boolean(
    config.profiling?.continuous ?? (config.features as any)?.continuousProfiling ?? false
  )
  const sampleRateHz = config.profiling?.sampleRateHz ?? PROFILING_DEFAULTS.continuousSampleRateHz
  const sampleIntervalMicroseconds =
    config.profiling?.sampleIntervalMicroseconds ??
    (sampleRateHz > 0 ? Math.round(1_000_000 / sampleRateHz) : PROFILING_DEFAULTS.sampleIntervalMicroseconds)

  return {
    enabled: config.features.profiling,
    cpu: PROFILING_DEFAULTS.cpu,
    heap: PROFILING_DEFAULTS.heap,
    sampleRate: config.sampling.profiles,
    maxDurationMs: config.profiling?.maxDurationMs ?? PROFILING_DEFAULTS.maxDurationMs,
    continuous,
    continuousIntervalMs: config.profiling?.continuousIntervalMs ?? PROFILING_DEFAULTS.continuousIntervalMs,
    sampleIntervalMicroseconds,
    sampleRateHz,
  }
}
