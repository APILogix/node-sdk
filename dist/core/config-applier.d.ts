import type { ConfigDiff, RemoteConfigResponse } from '../types/config.js';
export interface ConfigApplyContext {
    readonly diff: ConfigDiff;
    readonly previous: Readonly<RemoteConfigResponse>;
    readonly current: Readonly<RemoteConfigResponse>;
}
type ApplyHandler = (context: ConfigApplyContext) => void | Promise<void>;
export interface ConfigApplyHandlers {
    readonly identity?: ApplyHandler | undefined;
    readonly killswitches?: ApplyHandler | undefined;
    readonly sampling?: ApplyHandler | undefined;
    readonly features?: ApplyHandler | undefined;
    readonly limits?: ApplyHandler | undefined;
    readonly privacy?: ApplyHandler | undefined;
    readonly transport?: ApplyHandler | undefined;
    readonly instrumentation?: ApplyHandler | undefined;
    readonly entitlements?: ApplyHandler | undefined;
    readonly offlineQueue?: ApplyHandler | undefined;
}
/**
 * Applies a complete config replacement without restarting unaffected systems.
 * The ConfigManager owns the snapshot; this class owns only transition logic.
 */
export declare class ConfigApplier {
    private readonly handlers;
    constructor(handlers: ConfigApplyHandlers);
    diff(previous: Readonly<RemoteConfigResponse>, current: Readonly<RemoteConfigResponse>): ConfigDiff;
    hasChanges(diff: ConfigDiff): boolean;
    apply(diff: ConfigDiff, previous: Readonly<RemoteConfigResponse>, current: Readonly<RemoteConfigResponse>): Promise<void>;
}
export {};
