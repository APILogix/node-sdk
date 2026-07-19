/**
 * KillswitchEngine — reactive killswitch controller.
 *
 * Each killswitch maps to a subsystem shutdown/startup function pair.
 * When a killswitch flips via config refresh, the engine reacts within 5 seconds.
 *
 * Killswitch semantics:
 * - disableSDK: Every public method becomes a no-op. Zero data capture, zero network.
 * - disableTracing: Shut down TracerProvider, flush existing, destroy exporter.
 * - disableMetrics: Stop metric reader loop, flush, stop collection.
 * - disableErrors: Detach uncaughtException/unhandledRejection listeners, stop console.error.
 * - disableLogs: Stop console interception, drain buffer.
 * - disableProfiling: Stop profiler thread, flush in-flight profiles.
 * - disableTransport: Stop all HTTP outbound. Events queued locally. Auto-resumes on flip.
 */
import { getLogger } from '../utils/logger.js';
export class KillswitchEngine {
    static instance = null;
    currentState;
    handlers = new Map();
    sdkDisabled = false;
    destroyed = false;
    constructor(initialState) {
        this.currentState = { ...initialState };
        this.sdkDisabled = initialState.disableSDK;
    }
    static initialize(config) {
        if (KillswitchEngine.instance) {
            KillswitchEngine.instance.destroy();
        }
        KillswitchEngine.instance = new KillswitchEngine(config);
        return KillswitchEngine.instance;
    }
    static getInstance() {
        return KillswitchEngine.instance;
    }
    /**
     * Register a subsystem's shutdown/startup handlers.
     * If the killswitch is already active, immediately shuts down the subsystem.
     */
    registerSubsystem(killswitch, handlers) {
        this.handlers.set(killswitch, handlers);
        if (this.currentState[killswitch]) {
            const logger = getLogger();
            logger.warn(`[KillswitchEngine] ${killswitch} is active, shutting down subsystem immediately`);
            void Promise.resolve(handlers.shutdown()).catch(err => {
                logger.error(`[KillswitchEngine] Error shutting down ${killswitch}: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
    }
    /** Check if the SDK is globally disabled. */
    isSDKDisabled() {
        return this.sdkDisabled;
    }
    /** Check if a specific subsystem is killed. */
    isKilled(killswitch) {
        return this.currentState[killswitch];
    }
    /** Get the full killswitch state. */
    getState() {
        return { ...this.currentState };
    }
    /**
     * Handle config change event. Diffs killswitches and reacts.
     * Called by ConfigManager.onConfigChange().
     */
    async handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const logger = getLogger();
        const newKillswitches = newConfig.killswitches;
        const oldState = this.currentState;
        const killswitchKeys = [
            'disableSDK',
            'disableTracing',
            'disableMetrics',
            'disableTransport',
            'disableProfiling',
            'disableErrors',
            'disableLogs',
        ];
        for (const key of killswitchKeys) {
            const wasActive = oldState[key];
            const isActive = newKillswitches[key];
            if (wasActive === isActive)
                continue;
            const handlers = this.handlers.get(key);
            if (isActive && !wasActive) {
                // Killswitch activated
                logger.warn(`[KillswitchEngine] ACTIVATED: ${key}`);
                if (handlers) {
                    try {
                        await Promise.resolve(handlers.shutdown());
                    }
                    catch (err) {
                        logger.error(`[KillswitchEngine] Error during ${key} shutdown: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
            else if (!isActive && wasActive) {
                // Killswitch deactivated — resume
                logger.info(`[KillswitchEngine] DEACTIVATED: ${key} — resuming subsystem`);
                if (handlers) {
                    try {
                        await Promise.resolve(handlers.startup());
                    }
                    catch (err) {
                        logger.error(`[KillswitchEngine] Error during ${key} startup: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        }
        // Update state atomically
        this.currentState = { ...newKillswitches };
        this.sdkDisabled = newKillswitches.disableSDK;
    }
    destroy() {
        this.destroyed = true;
        this.handlers.clear();
        KillswitchEngine.instance = null;
    }
    static reset() {
        if (KillswitchEngine.instance) {
            KillswitchEngine.instance.destroy();
        }
    }
}
//# sourceMappingURL=killswitch-engine.js.map