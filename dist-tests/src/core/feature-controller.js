/**
 * FeatureController — controls subsystem instantiation based on features.* config.
 *
 * Key principle: If a feature is false, the subsystem class is NEVER instantiated.
 * This saves CPU and memory — we skip class instantiation entirely, not just "disable".
 *
 * On config refresh:
 * - Feature flips true → instantiate via factory()
 * - Feature flips false → teardown and destroy via teardown()
 *
 * Degraded mode: Only 'errors' and 'logging' subsystems are allowed.
 */
import { getLogger } from '../utils/logger.js';
export class FeatureController {
    static instance = null;
    currentFeatures;
    subsystems = new Map();
    degradedMode = false;
    destroyed = false;
    constructor(features) {
        this.currentFeatures = { ...features };
    }
    static initialize(features) {
        if (FeatureController.instance) {
            FeatureController.instance.destroy();
        }
        FeatureController.instance = new FeatureController(features);
        return FeatureController.instance;
    }
    static getInstance() {
        return FeatureController.instance;
    }
    /**
     * Enable degraded mode — only errors + logs are allowed.
     * Used when version policy requires degraded operation.
     */
    setDegradedMode(degraded) {
        this.degradedMode = degraded;
    }
    /**
     * Check if a feature is enabled.
     * In degraded mode, only 'errors' and 'logging' return true.
     */
    isEnabled(feature) {
        if (this.degradedMode) {
            return feature === 'errors' || feature === 'logging';
        }
        return this.currentFeatures[feature];
    }
    /**
     * Register a subsystem with its factory and teardown functions.
     * The factory is called only if the feature is currently enabled.
     */
    async register(feature, factory, teardown) {
        const registration = {
            feature,
            factory,
            teardown,
            alive: false,
        };
        this.subsystems.set(feature, registration);
        if (this.isEnabled(feature)) {
            const logger = getLogger();
            try {
                await Promise.resolve(factory());
                registration.alive = true;
                logger.info(`[FeatureController] Started subsystem: ${feature}`);
            }
            catch (err) {
                logger.error(`[FeatureController] Failed to start subsystem ${feature}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        else {
            getLogger().info(`[FeatureController] Skipping subsystem (disabled): ${feature}`);
        }
    }
    /**
     * Handle config change. Start/stop subsystems based on feature diffs.
     */
    async handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const logger = getLogger();
        const newFeatures = newConfig.features;
        const oldFeatures = this.currentFeatures;
        for (const [feature, registration] of this.subsystems) {
            const wasEnabled = oldFeatures[feature];
            const isEnabled = this.degradedMode
                ? feature === 'errors' || feature === 'logging'
                : newFeatures[feature];
            if (!wasEnabled && isEnabled && !registration.alive) {
                // Feature turned ON — instantiate
                logger.info(`[FeatureController] Feature enabled, starting: ${feature}`);
                try {
                    await Promise.resolve(registration.factory());
                    registration.alive = true;
                }
                catch (err) {
                    logger.error(`[FeatureController] Failed to start ${feature}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            else if (wasEnabled && !isEnabled && registration.alive) {
                // Feature turned OFF — teardown
                logger.info(`[FeatureController] Feature disabled, stopping: ${feature}`);
                try {
                    await Promise.resolve(registration.teardown());
                    registration.alive = false;
                }
                catch (err) {
                    logger.error(`[FeatureController] Failed to stop ${feature}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        this.currentFeatures = { ...newFeatures };
    }
    /** Get currently active subsystems. */
    getActiveSubsystems() {
        const active = [];
        for (const [feature, reg] of this.subsystems) {
            if (reg.alive)
                active.push(feature);
        }
        return active;
    }
    /** Teardown all active subsystems. */
    async teardownAll() {
        const logger = getLogger();
        for (const [feature, registration] of this.subsystems) {
            if (registration.alive) {
                try {
                    await Promise.resolve(registration.teardown());
                    registration.alive = false;
                    logger.info(`[FeatureController] Stopped subsystem: ${feature}`);
                }
                catch (err) {
                    logger.error(`[FeatureController] Error stopping ${feature}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
    }
    destroy() {
        this.destroyed = true;
        this.subsystems.clear();
        FeatureController.instance = null;
    }
    static reset() {
        if (FeatureController.instance) {
            void FeatureController.instance.teardownAll();
            FeatureController.instance.destroy();
        }
    }
}
