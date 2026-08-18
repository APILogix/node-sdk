import type { RemoteConfigResponse } from '../types/config.js';
export interface ValidationResult {
    readonly valid: boolean;
    readonly errors: readonly string[];
}
/**
 * Validate a complete replacement snapshot. No defaults, deep merges, or
 * partial patches are accepted: either every subsystem can consume the
 * document or the entire document is rejected.
 */
export declare function validateRemoteConfig(payload: unknown): ValidationResult;
export declare function assertRemoteConfig(payload: unknown): asserts payload is RemoteConfigResponse;
export declare function isRemoteConfigResponse(value: unknown): value is RemoteConfigResponse;
//# sourceMappingURL=config-validator.d.ts.map