/**
 * Validates the shape of a `RemoteConfigResponse` received from the
 * control plane.
 *
 * The SDK never trusts the wire payload blindly. Every field that
 * subsystems read is checked here; a missing or wrong-typed field flips
 * the response to "invalid" and the SDK falls back to baked-in safe
 * defaults. The validator is intentionally **lenient on extras** — the
 * backend can add new fields in a forward-compatible way without
 * breaking older SDKs.
 *
 * Why a hand-rolled validator instead of a Zod schema:
 *   - Zero-allocation hot path. Validation runs on every refresh, and
 *     building a Zod schema's parse tree per call is overhead we don't
 *     need.
 *   - Better error messages. We can collect every issue at once instead
 *     of failing at the first bad key.
 *   - No external coupling. The SDK already pulls Zod for `SDKInitOptions`,
 *     but the wire schema is a hot path and the tradeoff goes the other way.
 */
import type { RemoteConfigResponse } from '../types/config.js';
export interface ValidationResult {
    readonly valid: boolean;
    readonly errors: readonly string[];
}
/**
 * Validate a deserialized JSON payload as a `RemoteConfigResponse`.
 *
 * Returns `valid: true` if every required top-level section is present
 * with a plausible type. The fine-grained per-field shape (e.g. that
 * `limits.maxQueueSize` is a non-negative integer) is the safety
 * clamp's job — the validator only catches "nonsense top-level shape".
 */
export declare function validateRemoteConfig(payload: unknown): ValidationResult;
/**
 * Type guard — narrows `unknown` to `RemoteConfigResponse` after validation.
 * Useful at callsite to satisfy TypeScript without a manual cast.
 */
export declare function isRemoteConfigResponse(v: unknown): v is RemoteConfigResponse;
//# sourceMappingURL=config-validator.d.ts.map