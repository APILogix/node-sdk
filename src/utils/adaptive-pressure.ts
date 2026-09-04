/**
 * Adaptive Pressure Monitor — Unified Runtime Protection & 5-State Pressure Engine.
 *
 * Combines multiple pressure signals with hysteresis to prevent oscillation:
 * - Memory pressure (effective heap utilization ratio)
 * - Event loop lag (perf_hooks monitorEventLoopDelay p99)
 * - Queue depth (% of max capacity)
 * - GC pressure (PerformanceObserver GC duration tracking)
 *
 * 5-State State Machine:
 * - HEALTHY: Full admission of all telemetry.
 * - ELEVATED: Warning state; minor reduction of low-value P3 debug telemetry.
 * - PRESSURED: Aggressive P3 shedding, reduce optional metadata. Preserve P0/P1/P2 groups.
 * - CRITICAL: Protect the host application first. Preserve P0 and P1 diagnostic groups.
 * - RECOVERING: Smooth stepped recovery preventing backlog/replay storms.
 */

import { MemoryPressureMonitor, type PressureLevel } from './backpressure.js'
import { EventLoopLagMonitor } from './event-loop-lag.js'
import { getLogger } from './logger.js'
import type { PressureState } from '../types/telemetry-classes.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type CompositePressureLevel =
  | 'normal'
  | 'elevated'
  | 'high'
  | 'critical'
  | 'healthy'
  | 'pressured'
  | 'recovering'

export interface PressureSnapshot {
  readonly level: CompositePressureLevel
  readonly state: PressureState
  readonly memoryLevel: PressureLevel
  readonly effectiveMemoryUtilization: number
  readonly eventLoopLagMs: number
  readonly queueUtilization: number
  readonly gcPressure: number
  readonly score: number
  readonly transitions: number
}

export interface AdaptivePressureOptions {
  /** Polling interval in milliseconds. Default: 2000 */
  readonly pollIntervalMs?: number
  /** Function to get current queue utilization (0.0–1.0). */
  readonly getQueueUtilization?: () => number
  /** Optional absolute heap ceiling (MB). Passed to MemoryPressureMonitor. */
  readonly maxMemoryMb?: number
  /** Whether to monitor runtime memory pressure. Default: true */
  readonly runtimeMetrics?: boolean
  /** Whether to monitor event loop lag. Default: true */
  readonly eventLoopMonitoring?: boolean
  /** Whether to monitor GC pauses. Default: true */
  readonly gcMonitoring?: boolean
}

interface AdaptivePressureFeatureFlags {
  runtimeMetrics: boolean
  eventLoopMonitoring: boolean
  gcMonitoring: boolean
}

// ─── Hysteresis Thresholds ──────────────────────────────────────────────────

const ENTER_ELEVATED_SCORE = 35
const EXIT_ELEVATED_SCORE = 22

const ENTER_PRESSURE_SCORE = 55
const EXIT_PRESSURE_SCORE = 42

const ENTER_CRITICAL_SCORE = 78
const EXIT_CRITICAL_SCORE = 60

// ─── Implementation ─────────────────────────────────────────────────────────

export class AdaptivePressureMonitor {
  private readonly pollIntervalMs: number
  private getQueueUtilization: () => number
  private readonly memoryMonitor: MemoryPressureMonitor
  private readonly options: AdaptivePressureFeatureFlags

  private timer: ReturnType<typeof setInterval> | null = null
  private currentState: PressureState = 'HEALTHY'
  private recoveryCycles = 0
  private transitionCount = 0
  private recoveryTransitionCount = 0
  private lastSnapshot: PressureSnapshot
  private levelChangeCallbacks: Array<(snapshot: PressureSnapshot) => void> = []

  // High-precision event loop lag via perf_hooks histogram
  private readonly lagMonitor: EventLoopLagMonitor

  // GC tracking
  private gcObserver: PerformanceObserver | null = null
  private gcTimeMs = 0
  private gcWindowStart = 0

  constructor(options: AdaptivePressureOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.getQueueUtilization = options.getQueueUtilization ?? (() => 0)
    this.options = {
      runtimeMetrics: options.runtimeMetrics ?? true,
      eventLoopMonitoring: options.eventLoopMonitoring ?? true,
      gcMonitoring: options.gcMonitoring ?? true,
    }
    this.memoryMonitor = new MemoryPressureMonitor({
      pollIntervalMs: this.pollIntervalMs,
      maxMemoryMb: options.maxMemoryMb,
    })
    this.lagMonitor = new EventLoopLagMonitor({ emitIntervalMs: this.pollIntervalMs })
    this.lastSnapshot = {
      level: 'normal',
      state: 'HEALTHY',
      memoryLevel: 'normal',
      effectiveMemoryUtilization: 0,
      eventLoopLagMs: 0,
      queueUtilization: 0,
      gcPressure: 0,
      score: 0,
      transitions: 0,
    }
  }

  start(): void {
    if (this.timer) return

    if (this.options.runtimeMetrics) {
      this.memoryMonitor.start()
    }
    if (this.options.eventLoopMonitoring) {
      this.lagMonitor.start()
    }
    if (this.options.gcMonitoring) {
      this.startGCTracking()
    }
    this.gcWindowStart = Date.now()

    this.timer = setInterval(() => {
      this.poll()
    }, this.pollIntervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.memoryMonitor.stop()
    this.lagMonitor.stop()
    this.stopGCTracking()
    this.levelChangeCallbacks = []
  }

  /** Reset all monitoring state (useful after init warmup). */
  resetWarmup(): void {
    this.lagMonitor.reset()
    this.gcTimeMs = 0
    this.gcWindowStart = Date.now()
    this.currentState = 'HEALTHY'
    this.recoveryCycles = 0
  }

  configure(options: AdaptivePressureOptions): void {
    if (options.getQueueUtilization !== undefined) {
      this.getQueueUtilization = options.getQueueUtilization
    }
    if (options.runtimeMetrics !== undefined) {
      this.options.runtimeMetrics = options.runtimeMetrics
    }
    if (options.eventLoopMonitoring !== undefined) {
      this.options.eventLoopMonitoring = options.eventLoopMonitoring
    }
    if (options.gcMonitoring !== undefined) {
      this.options.gcMonitoring = options.gcMonitoring
    }
    if (options.maxMemoryMb !== undefined) {
      this.setMaxMemoryMb(options.maxMemoryMb)
    }

    if (this.timer) {
      if (this.options.runtimeMetrics) {
        this.memoryMonitor.start()
      } else {
        this.memoryMonitor.stop()
      }
      if (this.options.eventLoopMonitoring) {
        this.lagMonitor.start()
      } else {
        this.lagMonitor.stop()
      }
      if (this.options.gcMonitoring) {
        this.startGCTracking()
      } else {
        this.stopGCTracking()
      }
    }
  }

  getSnapshot(): PressureSnapshot {
    return this.lastSnapshot
  }

  getState(): PressureState {
    return this.currentState
  }

  /** Backward-compatible level getter returning 'normal' | 'elevated' | 'high' | 'critical'. */
  getLevel(): CompositePressureLevel {
    switch (this.currentState) {
      case 'HEALTHY': return 'normal'
      case 'ELEVATED': return 'elevated'
      case 'PRESSURED': return 'high'
      case 'CRITICAL': return 'critical'
      case 'RECOVERING': return 'elevated'
    }
  }

  setMaxMemoryMb(maxMemoryMb: number): void {
    this.memoryMonitor.setMaxMemoryMb(maxMemoryMb)
  }

  /**
   * Determine if an event should be shed based on current pressure state.
   */
  shouldShed(priority: 'critical' | 'high' | 'normal'): boolean {
    switch (this.currentState) {
      case 'HEALTHY':
        return false
      case 'ELEVATED':
        return false
      case 'PRESSURED':
        return priority === 'normal'
      case 'CRITICAL':
        return priority !== 'critical'
      case 'RECOVERING':
        return priority === 'normal'
    }
  }

  onLevelChange(callback: (snapshot: PressureSnapshot) => void): void {
    this.levelChangeCallbacks.push(callback)
  }

  // ─── Internal Engine ──────────────────────────────────────────────────────

  poll(): void {
    const now = Date.now()
    const currentLagMs = this.options.eventLoopMonitoring
      ? (this.lagMonitor.getStats()?.p99 ?? 0)
      : 0

    let gcPressure = 0
    if (this.options.gcMonitoring) {
      const gcWindowDuration = now - this.gcWindowStart
      gcPressure = gcWindowDuration > 0 ? (this.gcTimeMs / gcWindowDuration) * 100 : 0

      if (gcWindowDuration > 60_000) {
        this.gcTimeMs = 0
        this.gcWindowStart = now
      }
    } else {
      this.gcTimeMs = 0
      this.gcWindowStart = now
    }

    const memoryState = this.options.runtimeMetrics
      ? this.memoryMonitor.getState()
      : {
          level: 'normal' as PressureLevel,
          heapUsedMb: 0,
          heapTotalMb: 0,
          rssMb: 0,
          heapUtilization: 0,
          effectiveLimitMb: 1024,
          effectiveUtilization: 0,
        }
    const queueUtil = this.getQueueUtilization()

    // Score each individual signal
    const memoryScore = scoreMemory(memoryState.effectiveUtilization, memoryState.level)
    const lagScore = scoreLag(currentLagMs)
    const queueScore = scoreQueue(queueUtil)
    const gcScore = scoreGC(gcPressure)

    // Composite score: maximum across all monitored signals
    const compositeScore = Math.max(memoryScore, lagScore, queueScore, gcScore)

    // Transition state machine with hysteresis
    const nextState = this.evaluateStateWithHysteresis(compositeScore)
    const stateChanged = nextState !== this.currentState

    if (stateChanged) {
      const previousState = this.currentState
      this.currentState = nextState
      this.transitionCount++
      if (nextState === 'RECOVERING') this.recoveryTransitionCount++

      getLogger().info('[AdaptivePressure] Pressure state changed', {
        from: previousState,
        to: nextState,
        score: compositeScore,
        memoryUtil: `${(memoryState.effectiveUtilization * 100).toFixed(1)}%`,
        lagMs: currentLagMs,
        queueUtil: `${(queueUtil * 100).toFixed(1)}%`,
        gcPressure: `${gcPressure.toFixed(1)}%`,
      })
    }

    this.lastSnapshot = {
      level: this.getLevel(),
      state: this.currentState,
      memoryLevel: memoryState.level,
      effectiveMemoryUtilization: memoryState.effectiveUtilization,
      eventLoopLagMs: currentLagMs,
      queueUtilization: queueUtil,
      gcPressure,
      score: compositeScore,
      transitions: this.transitionCount,
    }

    if (stateChanged) {
      for (const callback of this.levelChangeCallbacks) {
        try {
          callback(this.lastSnapshot)
        } catch {
          // Never throw from listener callbacks
        }
      }
    }
  }

  private evaluateStateWithHysteresis(score: number): PressureState {
    const current = this.currentState

    switch (current) {
      case 'HEALTHY':
        if (score >= ENTER_CRITICAL_SCORE) return 'CRITICAL'
        if (score >= ENTER_PRESSURE_SCORE) return 'PRESSURED'
        if (score >= ENTER_ELEVATED_SCORE) return 'ELEVATED'
        return 'HEALTHY'

      case 'ELEVATED':
        if (score >= ENTER_CRITICAL_SCORE) return 'CRITICAL'
        if (score >= ENTER_PRESSURE_SCORE) return 'PRESSURED'
        if (score < EXIT_ELEVATED_SCORE) return 'HEALTHY'
        return 'ELEVATED'

      case 'PRESSURED':
        if (score >= ENTER_CRITICAL_SCORE) return 'CRITICAL'
        if (score < EXIT_PRESSURE_SCORE) {
          return 'RECOVERING'
        }
        return 'PRESSURED'

      case 'CRITICAL':
        if (score < EXIT_CRITICAL_SCORE) {
          this.recoveryCycles = 0
          return 'RECOVERING'
        }
        return 'CRITICAL'

      case 'RECOVERING':
        // If pressure re-spikes during recovery, return to high/critical immediately
        if (score >= ENTER_CRITICAL_SCORE) return 'CRITICAL'
        if (score >= ENTER_PRESSURE_SCORE) return 'PRESSURED'

        this.recoveryCycles++
        // Hold RECOVERING state for at least 2 consecutive healthy cycles
        if (score < EXIT_ELEVATED_SCORE && this.recoveryCycles >= 2) {
          this.recoveryCycles = 0
          return 'HEALTHY'
        }
        if (score < EXIT_PRESSURE_SCORE && this.recoveryCycles >= 2) {
          return 'ELEVATED'
        }
        return 'RECOVERING'
    }
  }

  private startGCTracking(): void {
    try {
      this.gcObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          this.gcTimeMs += entry.duration
        }
      })
      this.gcObserver.observe({ entryTypes: ['gc'] })
    } catch {
      // GC observation not supported in all Node.js environments
    }
  }

  private stopGCTracking(): void {
    if (this.gcObserver) {
      this.gcObserver.disconnect()
      this.gcObserver = null
    }
  }
}

// ─── Scoring Functions ──────────────────────────────────────────────────────

function scoreMemory(effectiveUtil: number, level: PressureLevel): number {
  if (level === 'critical' || effectiveUtil >= 0.88) return 85
  if (level === 'elevated' || effectiveUtil >= 0.70) return 60
  if (effectiveUtil >= 0.55) return 30
  return 0
}

function scoreLag(lagMs: number): number {
  if (lagMs < 50) return 0
  if (lagMs < 150) return 20
  if (lagMs < 350) return 40
  if (lagMs < 750) return 65
  return 85
}

function scoreQueue(utilization: number): number {
  if (utilization < 0.50) return 0
  if (utilization < 0.75) return 25
  if (utilization < 0.90) return 50
  return 80
}

function scoreGC(gcPercent: number): number {
  if (gcPercent < 10) return 0
  if (gcPercent < 25) return 25
  return 50
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const adaptivePressure = new AdaptivePressureMonitor()
