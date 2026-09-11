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
import type { KillswitchesConfig, ConfigDiff, RemoteConfigResponse } from '../types/config.js';
type SubsystemShutdownFn = () => Promise<void> | void;
type SubsystemStartupFn = () => Promise<void> | void;
interface SubsystemHandlers {
    shutdown: SubsystemShutdownFn;
    startup: SubsystemStartupFn;
}
export declare class KillswitchEngine {
    private static instance;
    private currentState;
    private handlers;
    private sdkDisabled;
    private destroyed;
    private constructor();
    static initialize(config: KillswitchesConfig): KillswitchEngine;
    static getInstance(): KillswitchEngine | null;
    /**
     * Register a subsystem's shutdown/startup handlers.
     * If the killswitch is already active, immediately shuts down the subsystem.
     */
    registerSubsystem(killswitch: keyof KillswitchesConfig, handlers: SubsystemHandlers): void;
    /** Check if the SDK is globally disabled. */
    isSDKDisabled(): boolean;
    /** Check if a specific subsystem is killed. */
    isKilled(killswitch: keyof KillswitchesConfig): boolean;
    /** Get the full killswitch state. */
    getState(): Readonly<KillswitchesConfig>;
    /**
     * Handle config change event. Diffs killswitches and reacts.
     * Called by ConfigManager.onConfigChange().
     */
    handleConfigChange(_diff: ConfigDiff, newConfig: Readonly<RemoteConfigResponse>): Promise<void>;
    destroy(): void;
    static reset(): void;
}
export {};
