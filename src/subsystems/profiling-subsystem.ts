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
    if (this.destroyed || !this.config.enabled || this.inspectorAvailable) return
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
    } catch (error) {
      logger.warn('[ProfilingSubsystem] Failed to initialize inspector', { error })
      this.inspectorAvailable = false
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
    if (!this.destroyed) this.config = resolveProfilingConfig(config)
  }

  async stop(): Promise<void> {
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
  return {
    enabled: config.features.profiling,
    cpu: PROFILING_DEFAULTS.cpu,
    heap: PROFILING_DEFAULTS.heap,
    sampleRate: config.sampling.profiles,
    maxDurationMs: PROFILING_DEFAULTS.maxDurationMs,
  }
}
