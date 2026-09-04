import { EventEmitter } from 'events'
import * as v8 from 'node:v8'

/**
 * Memory pressure levels — drive graceful degradation decisions.
 */
export type PressureLevel = 'normal' | 'elevated' | 'critical'

export interface MemoryPressureState {
  readonly level: PressureLevel
  readonly heapUsedMb: number
  readonly heapTotalMb: number
  readonly rssMb: number
  readonly heapUtilization: number
  readonly effectiveLimitMb: number
  readonly effectiveUtilization: number
}

export interface MemoryPressureOptions {
  /** Effective utilization threshold for 'elevated' (0.0–1.0). Default: 0.70 */
  readonly elevatedThreshold?: number
  /** Effective utilization threshold for 'critical' (0.0–1.0). Default: 0.88 */
  readonly criticalThreshold?: number
  /** Elevated exit threshold for hysteresis (0.0–1.0). Default: 0.60 */
  readonly elevatedExitThreshold?: number
  /** Critical exit threshold for hysteresis (0.0–1.0). Default: 0.75 */
  readonly criticalExitThreshold?: number
  /** Polling interval in milliseconds. Default: 5000 */
  readonly pollIntervalMs?: number
  /** Minimum heap total (MB) before utilization thresholds apply. Default: 100 */
  readonly minHeapTotalMb?: number
  /** Optional absolute ceiling (MB). When set, pressure is computed against this limit. */
  readonly maxMemoryMb?: number | undefined
}

/**
 * Monitors process memory and emits events when pressure levels change.
 * Uses effective heap limit and hysteresis to prevent false alarms during V8 heap expansion.
 */
export class MemoryPressureMonitor extends EventEmitter {
  private readonly elevatedThreshold: number
  private readonly criticalThreshold: number
  private readonly elevatedExitThreshold: number
  private readonly criticalExitThreshold: number
  private readonly pollIntervalMs: number
  private readonly minHeapTotalMb: number
  private maxMemoryMb: number | undefined
  private timer: NodeJS.Timeout | null = null
  private lastLevel: PressureLevel = 'normal'

  constructor(options: MemoryPressureOptions = {}) {
    super()
    this.elevatedThreshold = options.elevatedThreshold ?? 0.70
    this.criticalThreshold = options.criticalThreshold ?? 0.88
    this.elevatedExitThreshold = options.elevatedExitThreshold ?? 0.60
    this.criticalExitThreshold = options.criticalExitThreshold ?? 0.75
    this.pollIntervalMs = options.pollIntervalMs ?? 5000
    this.minHeapTotalMb = options.minHeapTotalMb ?? 100
    this.maxMemoryMb = options.maxMemoryMb
  }

  /** Start monitoring memory pressure. */
  start(): void {
    if (this.timer) return

    this.timer = setInterval(() => {
      this.check()
    }, this.pollIntervalMs)

    // Don't hold the process open just for memory monitoring
    this.timer.unref()
  }

  /** Stop monitoring. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Get current memory pressure state without emitting events. */
  getState(): MemoryPressureState {
    const mem = process.memoryUsage()
    const heapUsedMb = mem.heapUsed / (1024 * 1024)
    const heapTotalMb = mem.heapTotal / (1024 * 1024)
    const rssMb = mem.rss / (1024 * 1024)
    const heapUtilization = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0

    // Resolve the true effective memory ceiling (either configured maxMemoryMb or V8 heap limit)
    let effectiveLimitMb = this.maxMemoryMb && this.maxMemoryMb > 0
      ? this.maxMemoryMb
      : 0

    if (effectiveLimitMb <= 0) {
      try {
        const v8Limit = v8.getHeapStatistics().heap_size_limit
        effectiveLimitMb = v8Limit > 0 ? v8Limit / (1024 * 1024) : 1024
      } catch {
        effectiveLimitMb = 1024
      }
    }

    const effectiveUtilization = effectiveLimitMb > 0 ? heapUsedMb / effectiveLimitMb : 0

    // Compute pressure level with hysteresis
    let level: PressureLevel = this.lastLevel

    if (this.lastLevel === 'critical') {
      // Exit critical only if effective utilization drops below criticalExitThreshold
      if (effectiveUtilization < this.criticalExitThreshold) {
        level = effectiveUtilization >= this.elevatedThreshold ? 'elevated' : 'normal'
      }
    } else if (this.lastLevel === 'elevated') {
      if (effectiveUtilization >= this.criticalThreshold) {
        level = 'critical'
      } else if (effectiveUtilization < this.elevatedExitThreshold) {
        level = 'normal'
      }
    } else {
      // Currently normal
      if (effectiveUtilization >= this.criticalThreshold) {
        level = 'critical'
      } else if (effectiveUtilization >= this.elevatedThreshold) {
        level = 'elevated'
      }
    }

    // Secondary check: if heap is already large (> 75% of limit) AND heapTotal is nearly 100% full
    if (heapTotalMb >= this.minHeapTotalMb && heapTotalMb >= effectiveLimitMb * 0.75) {
      if (heapUtilization >= 0.95 && level === 'normal') {
        level = 'elevated'
      }
    }

    return {
      level,
      heapUsedMb,
      heapTotalMb,
      rssMb,
      heapUtilization,
      effectiveLimitMb,
      effectiveUtilization,
    }
  }

  /** Returns true if the system is under elevated or critical memory pressure. */
  isUnderPressure(): boolean {
    return this.getState().level !== 'normal'
  }

  /**
   * Check if an event should be accepted based on memory pressure and priority.
   */
  shouldAcceptEvent(priority: EventPriority): boolean {
    const level = this.getState().level
    switch (level) {
      case 'normal':
        return true
      case 'elevated':
        return priority !== 'normal'
      case 'critical':
        return priority === 'critical'
    }
  }

  /** Convenience method to register a pressure change callback. */
  onPressureChange(callback: (state: MemoryPressureState) => void): void {
    this.on('pressure', callback)
  }

  /** Update the absolute memory ceiling after construction. */
  setMaxMemoryMb(maxMemoryMb: number): void {
    this.maxMemoryMb = maxMemoryMb
  }

  private check(): void {
    const state = this.getState()

    if (state.level !== this.lastLevel) {
      this.lastLevel = state.level
      this.emit('pressure', state)
    }
  }
}

export type EventPriority = 'critical' | 'high' | 'normal'

/**
 * Get current memory pressure level without needing a monitor instance.
 * Quick one-shot check for use in hot paths.
 */
export function getMemoryPressureLevel(): PressureLevel {
  const mem = process.memoryUsage()
  const heapUsedMb = mem.heapUsed / (1024 * 1024)
  let effectiveLimitMb = 1024
  try {
    const v8Limit = v8.getHeapStatistics().heap_size_limit
    if (v8Limit > 0) effectiveLimitMb = v8Limit / (1024 * 1024)
  } catch {}

  const utilization = heapUsedMb / effectiveLimitMb
  if (utilization >= 0.88) return 'critical'
  if (utilization >= 0.70) return 'elevated'
  return 'normal'
}
