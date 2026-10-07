import type { ConfigDiff, RemoteConfigResponse } from '../types/config.js'
import { diffConfigs } from './config-differ.js'
import { getLogger } from '../utils/logger.js'

export interface ConfigApplyContext {
  readonly diff: ConfigDiff
  readonly previous: Readonly<RemoteConfigResponse>
  readonly current: Readonly<RemoteConfigResponse>
}

type ApplyHandler = (context: ConfigApplyContext) => void | Promise<void>

export interface ConfigApplyHandlers {
  readonly identity?: ApplyHandler | undefined
  readonly killswitches?: ApplyHandler | undefined
  readonly sampling?: ApplyHandler | undefined
  readonly features?: ApplyHandler | undefined
  readonly limits?: ApplyHandler | undefined
  readonly privacy?: ApplyHandler | undefined
  readonly transport?: ApplyHandler | undefined
  readonly instrumentation?: ApplyHandler | undefined
  readonly entitlements?: ApplyHandler | undefined
  readonly offlineQueue?: ApplyHandler | undefined
}

/**
 * Applies a complete config replacement without restarting unaffected systems.
 * The ConfigManager owns the snapshot; this class owns only transition logic.
 */
export class ConfigApplier {
  constructor(private readonly handlers: ConfigApplyHandlers) {}

  diff(previous: Readonly<RemoteConfigResponse>, current: Readonly<RemoteConfigResponse>): ConfigDiff {
    return diffConfigs(previous, current)
  }

  hasChanges(diff: ConfigDiff): boolean {
    return diff.sdkChanged
      || diff.featuresChanged
      || diff.killswitchesChanged
      || diff.samplingChanged
      || diff.transportChanged
      || diff.privacyChanged
      || diff.limitsChanged
      || diff.instrumentationChanged
      || diff.entitlementsChanged
      || Boolean(diff.offlineQueueChanged)
  }

  async apply(
    diff: ConfigDiff,
    previous: Readonly<RemoteConfigResponse>,
    current: Readonly<RemoteConfigResponse>,
  ): Promise<void> {
    const context: ConfigApplyContext = { diff, previous, current }
    const work: Array<readonly [string, ApplyHandler | undefined, boolean]> = [
      ['identity', this.handlers.identity, diff.sdkChanged],
      ['killswitches', this.handlers.killswitches, diff.killswitchesChanged],
      ['sampling', this.handlers.sampling, diff.samplingChanged],
      ['features', this.handlers.features, diff.featuresChanged],
      ['limits', this.handlers.limits, diff.limitsChanged],
      ['privacy', this.handlers.privacy, diff.privacyChanged],
      // Only the payload limit affects BatchManager construction; route queue
      // capacity lives in transport.queue, while limits.maxQueueSize bounds
      // the separate bootstrap queue.
      ['transport', this.handlers.transport, diff.transportChanged || haveTransportLimitsChanged(diff)],
      ['instrumentation', this.handlers.instrumentation, diff.instrumentationChanged || diff.privacyChanged],
      ['entitlements', this.handlers.entitlements, diff.entitlementsChanged],
      ['offlineQueue', this.handlers.offlineQueue, Boolean(diff.offlineQueueChanged)],
    ]

    for (const [name, handler, changed] of work) {
      if (!changed || !handler) continue
      try {
        await handler(context)
      } catch (error) {
        // One subsystem must not prevent independent sections from applying.
        getLogger().error(`[ConfigApplier] Failed to apply ${name} configuration`, { error })
      }
    }
  }
}


function haveTransportLimitsChanged(diff: ConfigDiff): boolean {
  return diff.changes.has('limits.maxPayloadSize')
}
