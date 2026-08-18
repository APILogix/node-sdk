/**
 * KillswitchEngine — reactive killswitch controller.
 *
 * Each killswitch maps to a subsystem shutdown/startup function pair and is
 * applied during the event-signalled configuration transition.
 *
 * Killswitch semantics:
 * - disableSDK: Every public method becomes a no-op. Zero data capture, zero network.
 * - disableTracing: Shut down TracerProvider, flush existing, destroy exporter.
 * - disableMetrics: Stop metric reader loop, flush, stop collection.
 * - disableErrors: Detach uncaughtException/unhandledRejection listeners, stop console.error.
 * - disableLogs: Stop console interception, drain buffer.
 * - disableProfiling: Stop profiler thread, flush in-flight profiles.
 * - disableTransport: Stop all HTTP outbound; router admission rejects new events until resumed.
 */

import type { KillswitchesConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import { getLogger } from '../utils/logger.js'

type SubsystemShutdownFn = () => Promise<void> | void
type SubsystemStartupFn = () => Promise<void> | void

interface SubsystemHandlers {
  shutdown: SubsystemShutdownFn
  startup: SubsystemStartupFn
}

export class KillswitchEngine {
  private static instance: KillswitchEngine | null = null

  private currentState: KillswitchesConfig
  private handlers: Map<keyof KillswitchesConfig, SubsystemHandlers> = new Map()
  private sdkDisabled: boolean = false
  private destroyed: boolean = false

  private constructor(initialState: KillswitchesConfig) {
    this.currentState = { ...initialState }
    this.sdkDisabled = initialState.disableSDK
  }

  static initialize(config: KillswitchesConfig): KillswitchEngine {
    if (KillswitchEngine.instance) {
      KillswitchEngine.instance.destroy()
    }
    KillswitchEngine.instance = new KillswitchEngine(config)
    return KillswitchEngine.instance
  }

  static getInstance(): KillswitchEngine | null {
    return KillswitchEngine.instance
  }

  /**
   * Register a subsystem's shutdown/startup handlers.
   * If the killswitch is already active, immediately shuts down the subsystem.
   */
  registerSubsystem(killswitch: keyof KillswitchesConfig, handlers: SubsystemHandlers): void {
    this.handlers.set(killswitch, handlers)

    if (this.currentState[killswitch]) {
      const logger = getLogger()
      logger.warn(`[KillswitchEngine] ${killswitch} is active, shutting down subsystem immediately`)
      void Promise.resolve(handlers.shutdown()).catch(err => {
        logger.error(
          `[KillswitchEngine] Error shutting down ${killswitch}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }

  /** Check if the SDK is globally disabled. */
  isSDKDisabled(): boolean {
    return this.sdkDisabled
  }

  /** Check if a specific subsystem is killed. */
  isKilled(killswitch: keyof KillswitchesConfig): boolean {
    return this.currentState[killswitch]
  }

  /** Get the full killswitch state. */
  getState(): Readonly<KillswitchesConfig> {
    return { ...this.currentState }
  }

  /**
   * Handle config change event. Diffs killswitches and reacts.
   * Called by ConfigManager.onConfigChange().
   */
  async handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): Promise<void> {
    if (this.destroyed) return

    const logger = getLogger()
    const newKillswitches = newConfig.killswitches
    const oldState = this.currentState

    const killswitchKeys: (keyof KillswitchesConfig)[] = [
      'disableSDK',
      'disableTracing',
      'disableMetrics',
      'disableTransport',
      'disableProfiling',
      'disableErrors',
      'disableLogs',
    ]

    for (const key of killswitchKeys) {
      const wasActive = oldState[key]
      const isActive = newKillswitches[key]

      if (wasActive === isActive) continue

      const handlers = this.handlers.get(key)

      if (isActive && !wasActive) {
        // Killswitch activated
        logger.warn(`[KillswitchEngine] ACTIVATED: ${key}`)
        if (handlers) {
          try {
            await Promise.resolve(handlers.shutdown())
          } catch (err) {
            logger.error(
              `[KillswitchEngine] Error during ${key} shutdown: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      } else if (!isActive && wasActive) {
        // Killswitch deactivated — resume
        logger.info(`[KillswitchEngine] DEACTIVATED: ${key} — resuming subsystem`)
        if (handlers) {
          try {
            await Promise.resolve(handlers.startup())
          } catch (err) {
            logger.error(
              `[KillswitchEngine] Error during ${key} startup: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      }
    }

    // Update state atomically
    this.currentState = { ...newKillswitches }
    this.sdkDisabled = newKillswitches.disableSDK
  }

  destroy(): void {
    this.destroyed = true
    this.handlers.clear()
    KillswitchEngine.instance = null
  }

  static reset(): void {
    if (KillswitchEngine.instance) {
      KillswitchEngine.instance.destroy()
    }
  }
}
