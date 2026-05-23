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
import type { FeaturesConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
type SubsystemFactory = () => Promise<void> | void;
type SubsystemTeardown = () => Promise<void> | void;
export declare class FeatureController {
    private static instance;
    private currentFeatures;
    private subsystems;
    private degradedMode;
    private destroyed;
    private constructor();
    static initialize(features: FeaturesConfig): FeatureController;
    static getInstance(): FeatureController | null;
    /**
     * Enable degraded mode — only errors + logs are allowed.
     * Used when version policy requires degraded operation.
     */
    setDegradedMode(degraded: boolean): void;
    /**
     * Check if a feature is enabled.
     * In degraded mode, only 'errors' and 'logging' return true.
     */
    isEnabled(feature: keyof FeaturesConfig): boolean;
    /**
     * Register a subsystem with its factory and teardown functions.
     * The factory is called only if the feature is currently enabled.
     */
    register(feature: keyof FeaturesConfig, factory: SubsystemFactory, teardown: SubsystemTeardown): Promise<void>;
    /**
     * Handle config change. Start/stop subsystems based on feature diffs.
     */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): Promise<void>;
    /** Get currently active subsystems. */
    getActiveSubsystems(): string[];
    /** Teardown all active subsystems. */
    teardownAll(): Promise<void>;
    destroy(): void;
    static reset(): void;
}
export {};
//# sourceMappingURL=feature-controller.d.ts.map