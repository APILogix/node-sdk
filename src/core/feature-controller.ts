/**
 * FeatureController — controls subsystem instantiation based on features.* config.
 *
 * Key principle: If a feature is false, the subsystem class is NEVER instantiated.
 * This saves CPU and memory — we skip class instantiation entirely, not just "disable".
 *
 * On config refresh:
 * - Feature flips true → instantiate via factory()
 * - Feature flips false → teardown and destroy via teardown()
 */

import type { FeaturesConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import { getLogger } from '../utils/logger.js'

type SubsystemFactory = () => Promise<void> | void
type SubsystemTeardown = () => Promise<void> | void

interface SubsystemRegistration {
  readonly feature: keyof FeaturesConfig
  readonly factory: SubsystemFactory
  readonly teardown: SubsystemTeardown
  alive: boolean
}

export class FeatureController {
  private static instance: FeatureController | null = null

  private currentFeatures: FeaturesConfig
  private subsystems: Map<keyof FeaturesConfig, SubsystemRegistration> = new Map()
  private destroyed: boolean = false

  private constructor(features: FeaturesConfig) {
    this.currentFeatures = { ...features }
  }

  static initialize(features: FeaturesConfig): FeatureController {
    if (FeatureController.instance) {
      FeatureController.instance.destroy()
    }
    FeatureController.instance = new FeatureController(features)
    return FeatureController.instance
  }

  static getInstance(): FeatureController | null {
    return FeatureController.instance
  }

  /** Check whether a backend-owned feature is enabled. */
  isEnabled(feature: keyof FeaturesConfig): boolean {
    return this.currentFeatures[feature]
  }

  /**
   * Register a subsystem with its factory and teardown functions.
   * The factory is called only if the feature is currently enabled.
   */
  async register(
    feature: keyof FeaturesConfig,
    factory: SubsystemFactory,
    teardown: SubsystemTeardown
  ): Promise<void> {
    const registration: SubsystemRegistration = {
      feature,
      factory,
      teardown,
      alive: false,
    }

    this.subsystems.set(feature, registration)

    if (this.isEnabled(feature)) {
      const logger = getLogger()
      try {
        await Promise.resolve(factory())
        registration.alive = true
        logger.info(`[FeatureController] Started subsystem: ${feature}`)
      } catch (err) {
        logger.error(
          `[FeatureController] Failed to start subsystem ${feature}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    } else {
      getLogger().info(`[FeatureController] Skipping subsystem (disabled): ${feature}`)
    }
  }

  /**
   * Handle config change. Start/stop subsystems based on feature diffs.
   */
  async handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): Promise<void> {
    if (this.destroyed) return

    const logger = getLogger()
    const newFeatures = newConfig.features
    const oldFeatures = this.currentFeatures

    for (const [feature, registration] of this.subsystems) {
      const wasEnabled = oldFeatures[feature]
      const isEnabled = newFeatures[feature]

      if (!wasEnabled && isEnabled && !registration.alive) {
        // Feature turned ON — instantiate
        logger.info(`[FeatureController] Feature enabled, starting: ${feature}`)
        try {
          await Promise.resolve(registration.factory())
          registration.alive = true
        } catch (err) {
          logger.error(
            `[FeatureController] Failed to start ${feature}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      } else if (wasEnabled && !isEnabled && registration.alive) {
        // Feature turned OFF — teardown
        logger.info(`[FeatureController] Feature disabled, stopping: ${feature}`)
        try {
          await Promise.resolve(registration.teardown())
          registration.alive = false
        } catch (err) {
          logger.error(
            `[FeatureController] Failed to stop ${feature}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }

    this.currentFeatures = { ...newFeatures }
  }

  /** Get currently active subsystems. */
  getActiveSubsystems(): string[] {
    const active: string[] = []
    for (const [feature, reg] of this.subsystems) {
      if (reg.alive) active.push(feature)
    }
    return active
  }

  /** Teardown all active subsystems. */
  async teardownAll(): Promise<void> {
    const logger = getLogger()
    for (const [feature, registration] of this.subsystems) {
      if (registration.alive) {
        try {
          await Promise.resolve(registration.teardown())
          registration.alive = false
          logger.info(`[FeatureController] Stopped subsystem: ${feature}`)
        } catch (err) {
          logger.error(
            `[FeatureController] Error stopping ${feature}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    this.subsystems.clear()
    FeatureController.instance = null
  }

  static reset(): void {
    if (FeatureController.instance) {
      void FeatureController.instance.teardownAll()
      FeatureController.instance.destroy()
    }
  }
}
