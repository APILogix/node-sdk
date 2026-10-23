import { diffConfigs } from './config-differ.js';
import { getLogger } from '../utils/logger.js';
/**
 * Applies a complete config replacement without restarting unaffected systems.
 * The ConfigManager owns the snapshot; this class owns only transition logic.
 */
export class ConfigApplier {
    handlers;
    constructor(handlers) {
        this.handlers = handlers;
    }
    diff(previous, current) {
        return diffConfigs(previous, current);
    }
    hasChanges(diff) {
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
            || Boolean(diff.metricsSectionChanged)
            || Boolean(diff.metricsChanged)
            || Boolean(diff.tracingSectionChanged)
            || Boolean(diff.tracingChanged);
    }
    async apply(diff, previous, current) {
        const context = { diff, previous, current };
        const work = [
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
            ['metrics', this.handlers.metrics, Boolean(diff.metricsSectionChanged || diff.metricsChanged)],
            ['tracing', this.handlers.tracing, Boolean(diff.tracingSectionChanged || diff.tracingChanged)],
        ];
        for (const [name, handler, changed] of work) {
            if (!changed || !handler)
                continue;
            try {
                await handler(context);
            }
            catch (error) {
                // One subsystem must not prevent independent sections from applying.
                getLogger().error(`[ConfigApplier] Failed to apply ${name} configuration`, { error });
            }
        }
    }
}
function haveTransportLimitsChanged(diff) {
    return diff.changes.has('limits.maxPayloadSize');
}
