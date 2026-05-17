import { EventEmitter } from 'events'

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
}

export interface MemoryPressureOptions {
  /** Heap utilization threshold for 'elevated' (0.0–1.0). Default: 0.7 */
  readonly elevatedThreshold?: number
  /** Heap utilization threshold for 'critical' (0.0–1.0). Default: 0.9 */
  readonly criticalThreshold?: number
  /** Polling interval in milliseconds. Default: 5000 */
  readonly pollIntervalMs?: number
  /** Minimum heap total (MB) before utilization thresholds apply. Default: 100 */
  readonly minHeapTotalMb?: number
}

/**
 * Monitors process memory and emits events when pressure levels change.
 *
 * Usage:
 *   const monitor = new MemoryPressureMonitor()
 *   monitor.on('pressure', (state) => { ... })
 *   monitor.start()
 *   // ... later
 *   monitor.stop()
 */
export class MemoryPressureMonitor extends EventEmitter {
  private readonly elevatedThreshold: number
  private readonly criticalThreshold: number
  private readonly pollIntervalMs: number
  private readonly minHeapTotalMb: number
  private timer: NodeJS.Timeout | null = null
  private lastLevel: PressureLevel = 'normal'

  constructor(options: MemoryPressureOptions = {}) {
    super()
    this.elevatedThreshold = options.elevatedThreshold ?? 0.7
    this.criticalThreshold = options.criticalThreshold ?? 0.9
    this.pollIntervalMs = options.pollIntervalMs ?? 5000
    this.minHeapTotalMb = options.minHeapTotalMb ?? 100
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

    // If heap is small (< minHeapTotalMb), utilization ratio is meaningless
    // V8 starts with a tiny heap that grows on demand — high ratio on small
    // heap does NOT indicate actual pressure.
    let level: PressureLevel = 'normal'
    if (heapTotalMb >= this.minHeapTotalMb) {
      if (heapUtilization >= this.criticalThreshold) {
        level = 'critical'
      } else if (heapUtilization >= this.elevatedThreshold) {
        level = 'elevated'
      }
    }

    return { level, heapUsedMb, heapTotalMb, rssMb, heapUtilization }
  }

  /** Returns true if the system is under elevated or critical memory pressure. */
  isUnderPressure(): boolean {
    return this.getState().level !== 'normal'
  }

  private check(): void {
    const state = this.getState()

    if (state.level !== this.lastLevel) {
      this.lastLevel = state.level
      this.emit('pressure', state)
    }
  }
}
