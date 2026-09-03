import type { NormalizedRemoteConfig, RemoteConfigResponse, ConfigDiff } from '../types/config.js';
/**
 * Diff two remote config snapshots. Returns section-level flags, subsystem fast flags,
 * structured change collections, and detailed field-level change descriptors.
 *
 * Guaranteed crash-proof against null/undefined or corrupted input objects.
 */
export declare function diffConfigs(oldConfig: Readonly<NormalizedRemoteConfig | RemoteConfigResponse> | null | undefined, newConfig: Readonly<NormalizedRemoteConfig | RemoteConfigResponse> | null | undefined): ConfigDiff;
export declare function deepEqual(a: unknown, b: unknown): boolean;
