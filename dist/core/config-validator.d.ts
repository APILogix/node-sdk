import type { NormalizedRemoteConfig, RemoteConfigResponse } from '../types/config.js';
export interface ValidationResult {
    readonly valid: boolean;
    readonly errors: readonly string[];
}
/**
 * Validate a complete replacement snapshot against Schema v1 and safety bounds.
 * No defaults, deep merges, or partial patches are accepted: either every subsystem
 * can consume the document or the entire document is rejected.
 */
export declare function validateRemoteConfig(payload: unknown): ValidationResult;
export declare function assertRemoteConfig(payload: unknown): asserts payload is NormalizedRemoteConfig;
export declare function isRemoteConfigResponse(value: unknown): value is RemoteConfigResponse;
export declare function isNormalizedRemoteConfig(value: unknown): value is NormalizedRemoteConfig;
/**
 * Recursively freezes any JavaScript object or array, protecting against circular structures.
 */
export declare function deepFreeze<T>(value: T, visited?: WeakSet<object>): Readonly<T>;
/**
 * Normalizes a candidate wire payload into a guaranteed, deep-frozen NormalizedRemoteConfig.
 * If payload is invalid or malformed, uses fallback configuration.
 */
export declare function normalizeRemoteConfig(payload: unknown, fallback?: NormalizedRemoteConfig): Readonly<NormalizedRemoteConfig>;
/**
 * Safe fallback resolver that checks candidate payload and returns structured status.
 */
export declare function validateOrFallback(payload: unknown, fallback?: NormalizedRemoteConfig): {
    readonly config: Readonly<NormalizedRemoteConfig>;
    readonly valid: boolean;
    readonly errors: readonly string[];
    readonly usedFallback: boolean;
};
