/**
 * ProfilingSubsystem — CPU and heap profiling driven by remote config.
 *
 * Behavior:
 * - Only started when features.profiling = true AND profiling.enabled = true.
 * - CPU profiling: Uses Node.js inspector API to capture V8 CPU profiles.
 * - Heap profiling: Uses Node.js inspector API for heap snapshots.
 * - sampleRate: FNV-1a hash on traceId decides whether to profile a request.
 * - maxDurationMs: Hard cap on individual profile duration.
 * - Emits ProfileEvent objects to transport layer.
 * - Killswitch: disableProfiling → stop inspector, flush in-flight profiles.
 *
 * Note: The inspector API requires --inspect flag or explicit Session creation.
 * The subsystem gracefully degrades if inspector is not available.
 */

import type { ProfilingConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import type { ProfileEvent, EventMetadata } from '../types/event.js'
import { getRequestContext } from '../core/context.js'
import { getLogger } from '../utils/logger.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { trace } from '@opentelemetry/api'

type ProfileEmitter = (event: ProfileEvent) => void

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

  private config: ProfilingConfig
  private emitter: ProfileEmitter
  private metadata: EventMetadata
  private activeProfiles: Map<string, ActiveProfile> = new Map()
  private inspectorSession: unknown = null
  private inspectorAvailable: boolean = false
  private destroyed: boolean = false

  private constructor(config: ProfilingConfig, emitter: ProfileEmitter, metadata: EventMetadata) {
    this.config = { ...config }
    this.emitter = emitter
    this.metadata = metadata
  }

  static initialize(config: ProfilingConfig, emitter: ProfileEmitter, metadata: EventMetadata): ProfilingSubsystem {
    if (ProfilingSubsystem.instance) {
      ProfilingSubsystem.instance.destroy()
    }
    ProfilingSubsystem.instance = new ProfilingSubsystem(config, emitter, metadata)
    return ProfilingSubsystem.instance
  }

  static getInstance(): ProfilingSubsystem | null {
    return ProfilingSubsystem.instance
  }

  /** Initialize the inspector session. */
  async start(): Promise<void> {
    if (this.destroyed || !this.config.enabled) return

    const logger = getLogger()

    try {
      // Dynamic import to avoid requiring inspector at load time
      const inspector = await import('node:inspector/promises').catch(() => null)
      if (inspector) {
        const session = new inspector.Session()
        session.connect()
        this.inspectorSession = session
        this.inspectorAvailable = true
        logger.info('[ProfilingSubsystem] Inspector session connected')
      } else {
        logger.warn('[ProfilingSubsystem] Inspector API not available — profiling disabled')
        this.inspectorAvailable = false
      }
    } catch (err) {
      logger.warn(
        `[ProfilingSubsystem] Failed to initialize inspector: ${err instanceof Error ? err.message : String(err)}`
      )
      this.inspectorAvailable = false
    }
  }

  /**
   * Start a CPU profile for the given trace.
   * Call this at the beginning of a request if sampling decides to profile.
   */
  async startCpuProfile(traceId?: string, spanId?: string): Promise<boolean> {
    if (!this.canProfile('cpu')) return false

    const session = this.inspectorSession as { post: (method: string) => Promise<void> } | null
    if (!session) return false

    const activeSpan = trace.getActiveSpan()
    const activeSpanContext = activeSpan?.spanContext()
    const resolvedTraceId = traceId ?? activeSpanContext?.traceId
    if (!resolvedTraceId) return false
    if (!this.shouldProfile(resolvedTraceId)) return false

    const resolvedSpanId = spanId ?? activeSpanContext?.spanId
    const requestId = getRequestContext()?.requestId
    const key = `cpu:${resolvedTraceId}`
    if (this.activeProfiles.has(key)) return false

    try {
      await session.post('Profiler.enable')
      await session.post('Profiler.start')

      const startTime = Date.now()
      const timeoutHandle = setTimeout(() => {
        void this.stopCpuProfile(resolvedTraceId)
      }, this.config.maxDurationMs)

      if (typeof timeoutHandle === 'object' && 'unref' in timeoutHandle) {
        ;(timeoutHandle as NodeJS.Timeout).unref()
      }

      this.activeProfiles.set(key, {
        traceId: resolvedTraceId,
        spanId: resolvedSpanId,
        requestId,
        profileType: 'cpu',
        startTime,
        timeoutHandle,
      })

      activeSpan?.addEvent('pulse.profile.start', {
        'profile.type': 'cpu',
        'profile.id': key,
      })
      activeSpan?.setAttribute('pulse.profile.active', true)

      return true
    } catch (err) {
      getLogger().warn(
        `[ProfilingSubsystem] Failed to start CPU profile: ${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }

  /**
   * Stop a CPU profile and emit the ProfileEvent.
   */
  async stopCpuProfile(traceId: string): Promise<void> {
    const key = `cpu:${traceId}`
    const active = this.activeProfiles.get(key)
    if (!active) return

    this.activeProfiles.delete(key)
    if (active.timeoutHandle) clearTimeout(active.timeoutHandle)

    const session = this.inspectorSession as {
      post: (method: string) => Promise<{ profile: unknown }>
    } | null
    if (!session) return

    try {
      const result = await session.post('Profiler.stop')
      const endTime = Date.now()

      // Scrub the raw V8 profile payload — sampled stack frames can carry
      // file paths and, via function/source names, fragments of user data.
      // Fail-open when the scrubber isn't initialized: the pipeline-level
      // scrub still runs before transport.
      const scrubber = SecurityScrubber.getInstance()
      const scrubbedProfile = scrubber ? scrubber.scrubValue(result.profile) : result.profile

      const event: ProfileEvent = {
        type: 'profile',
        profileType: 'cpu',
        traceId: active.traceId,
        spanId: active.spanId,
        requestId: active.requestId,
        startTime: active.startTime,
        endTime,
        duration: endTime - active.startTime,
        profile: scrubbedProfile,
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
    } catch (err) {
      getLogger().warn(
        `[ProfilingSubsystem] Failed to stop CPU profile: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Handle config change. Same pattern as `LoggingSubsystem.handleConfigChange`:
   * `init.ts` synthesizes a `profiling` block (SDK defaults + `features.profiling`)
   * onto the config object. We pull it back out via a typed cast since the
   * public schema no longer carries the field.
   */
  handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): void {
    if (this.destroyed) return
    const synthesized = (newConfig as unknown as { profiling?: import('../types/config.js').ProfilingConfig }).profiling
    if (synthesized) this.config = { ...synthesized }
  }

  /** Stop all active profiles and disconnect inspector. */
  async stop(): Promise<void> {
    // Stop all active profiles
    for (const [key, active] of this.activeProfiles) {
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle)
      this.activeProfiles.delete(key)
    }

    // Disconnect inspector
    if (this.inspectorSession && this.inspectorAvailable) {
      try {
        const session = this.inspectorSession as { disconnect: () => void }
        session.disconnect()
      } catch {
        // Ignore disconnect errors
      }
      this.inspectorSession = null
      this.inspectorAvailable = false
    }

    getLogger().info('[ProfilingSubsystem] Stopped')
  }

  private canProfile(type: 'cpu' | 'heap'): boolean {
    if (this.destroyed || !this.config.enabled || !this.inspectorAvailable) return false
    if (type === 'cpu' && !this.config.cpu) return false
    if (type === 'heap' && !this.config.heap) return false
    return true
  }

  private shouldProfile(traceId: string): boolean {
    if (this.config.sampleRate >= 1) return true
    if (this.config.sampleRate <= 0) return false

    let hash = 2166136261
    for (let i = 0; i < traceId.length; i += 1) {
      hash ^= traceId.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0) / 0xffffffff < this.config.sampleRate
  }

  destroy(): void {
    void this.stop()
    this.destroyed = true
    ProfilingSubsystem.instance = null
  }

  static reset(): void {
    if (ProfilingSubsystem.instance) {
      ProfilingSubsystem.instance.destroy()
    }
  }
}
