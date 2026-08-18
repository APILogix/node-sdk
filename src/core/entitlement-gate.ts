/**
 * EntitlementGate — backend billing/capability gates.
 *
 * Distinct from operational features and killswitches:
 *
 *   - `features.*` decides whether a subsystem exists.
 *   - `killswitches.*` is an emergency operational stop.
 *   - `entitlements.*` gates optional developer APIs and the explicitly
 *     modeled automatic request/tracing/error/metrics paths.
 *
 * Semantics:
 *
 *   - **Complete after init.** Every validated snapshot contains every
 *     entitlement boolean. No defaults or partial entitlement merge exists.
 *   - **Pre-init buffering only.** Static checks allow bootstrap telemetry
 *     before a snapshot exists; the validated backend section becomes
 *     authoritative as soon as initialization completes.
 *   - **No-op, never throw.** A denied API returns a noop implementation
 *     or silently drops the call so application code keeps running.
 *   - **Core APIs are never gated.** `captureError()`, `captureMessage()`,
 *     `setUser()`, `setTag()`, `setContext()`, `addBreadcrumb()`, `flush()`
 *     and `shutdown()` do not consult this gate — they are fundamental to
 *     any SDK integration regardless of plan.
 *
 * The gate is consulted on hot paths (custom APIs and automatic capture), so
 * reads are a plain object lookup with no logging or allocation.
 */

import type { EntitlementsConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import { getLogger } from '../utils/logger.js'

export class EntitlementGate {
  private static instance: EntitlementGate | null = null

  private currentState: EntitlementsConfig
  private destroyed: boolean = false

  private constructor(initialState: EntitlementsConfig) {
    this.currentState = { ...initialState }
  }

  static initialize(entitlements: EntitlementsConfig): EntitlementGate {
    if (EntitlementGate.instance) {
      EntitlementGate.instance.destroy()
    }
    EntitlementGate.instance = new EntitlementGate(entitlements)
    return EntitlementGate.instance
  }

  static getInstance(): EntitlementGate | null {
    return EntitlementGate.instance
  }

  /**
   * Check whether an optional telemetry API family is entitled.
   * Instance method — hot path, allocation-free.
   */
  isAllowed(entitlement: keyof EntitlementsConfig): boolean {
    return this.currentState[entitlement]
  }

  /**
   * Static convenience for call sites that may run before `initialize()`
   * (for bootstrap capture before a validated snapshot exists). This temporary
   * pre-init behavior preserves buffering; it is not a wire-schema default.
   */
  static isAllowed(entitlement: keyof EntitlementsConfig): boolean {
    const gate = EntitlementGate.instance
    if (!gate || gate.destroyed) return true
    return gate.currentState[entitlement]
  }

  /** Get the full entitlement state (defensive copy). */
  getState(): Readonly<EntitlementsConfig> {
    return { ...this.currentState }
  }

  /**
   * Handle config change event. Called by ConfigManager.onConfigChange().
   * Entitlement flips take effect immediately for new API calls; in-flight
   * spans/profiles are allowed to finish so traces stay coherent.
   */
  async handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): Promise<void> {
    if (this.destroyed) return

    const next = { ...newConfig.entitlements }
    const logger = getLogger()

    for (const key of Object.keys(next) as (keyof EntitlementsConfig)[]) {
      const was = this.currentState[key]
      const is = next[key]
      if (was === is) continue
      if (is) {
        logger.info(`[EntitlementGate] entitlement ENABLED: ${key}`)
      } else {
        logger.warn(`[EntitlementGate] entitlement REVOKED: ${key} — developer API becomes no-op`)
      }
    }

    this.currentState = next
  }

  destroy(): void {
    this.destroyed = true
    EntitlementGate.instance = null
  }

  static reset(): void {
    if (EntitlementGate.instance) {
      EntitlementGate.instance.destroy()
    }
  }
}
