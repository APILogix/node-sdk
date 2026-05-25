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

import type { RemoteConfigResponse } from '../types/config.js'
import { REMOTE_CONFIG_SCHEMA_VERSION } from '../types/config.js'

export interface ValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

/**
 * Validate a deserialized JSON payload as a `RemoteConfigResponse`.
 *
 * Returns `valid: true` if every required top-level section is present
 * with a plausible type. The fine-grained per-field shape (e.g. that
 * `limits.maxQueueSize` is a non-negative integer) is the safety
 * clamp's job — the validator only catches "nonsense top-level shape".
 */
export function validateRemoteConfig(payload: unknown): ValidationResult {
  const errors: string[] = []

  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload is not a JSON object'] }
  }
  const cfg = payload as Record<string, unknown>

  // Schema version — required, must be a positive integer, must not exceed
  // what this SDK was compiled against.
  if (typeof cfg['schemaVersion'] !== 'number' || !Number.isInteger(cfg['schemaVersion']) || cfg['schemaVersion'] < 1) {
    errors.push('schemaVersion is missing or not a positive integer')
  } else if ((cfg['schemaVersion'] as number) > REMOTE_CONFIG_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion ${cfg['schemaVersion']} is newer than SDK-supported ${REMOTE_CONFIG_SCHEMA_VERSION}; SDK upgrade required`,
    )
  }

  // Required top-level sections. Each must be a plain object.
  for (const section of ['features', 'sampling', 'instrumentation', 'privacy', 'limits', 'killswitches', 'transport', 'runtime'] as const) {
    if (!isPlainObject(cfg[section])) {
      errors.push(`${section} is missing or not an object`)
    }
  }

  // sdk identity — required object with at least projectId + environment.
  if (!isPlainObject(cfg['sdk'])) {
    errors.push('sdk is missing or not an object')
  } else {
    const sdk = cfg['sdk'] as Record<string, unknown>
    if (typeof sdk['projectId'] !== 'string' || sdk['projectId'].length === 0) {
      errors.push('sdk.projectId is missing or empty')
    }
    if (typeof sdk['environment'] !== 'string' || sdk['environment'].length === 0) {
      errors.push('sdk.environment is missing or empty')
    }
  }

  // transport.routes — must contain url strings for every route name. The
  // safety clamp can fix bad numerics, but a missing URL means we have
  // nowhere to send.
  const transport = cfg['transport']
  if (isPlainObject(transport)) {
    const routes = (transport as Record<string, unknown>)['routes']
    if (!isPlainObject(routes)) {
      errors.push('transport.routes is missing or not an object')
    } else {
      for (const [name, route] of Object.entries(routes as Record<string, unknown>)) {
        if (!isPlainObject(route)) {
          errors.push(`transport.routes.${name} is not an object`)
          continue
        }
        const r = route as Record<string, unknown>
        if (typeof r['url'] !== 'string' || r['url'].length === 0) {
          errors.push(`transport.routes.${name}.url is missing or empty`)
        }
      }
    }
  }

  // sampling.* — per-event-type rates must be numbers in [0, 1].
  const sampling = cfg['sampling']
  if (isPlainObject(sampling)) {
    const s = sampling as Record<string, unknown>
    for (const k of ['traces', 'requests', 'errors', 'profiles', 'replays']) {
      if (k in s && !isProbability(s[k])) {
        errors.push(`sampling.${k} is not a number in [0, 1]`)
      }
    }
  }

  // features.* — every value must be boolean (we don't list every key here;
  // the deep-merge will keep unknown extras). A wrong-typed value is the
  // dangerous case — `1` for `tracing` would coerce truthy and silently
  // turn things on.
  const features = cfg['features']
  if (isPlainObject(features)) {
    for (const [k, v] of Object.entries(features as Record<string, unknown>)) {
      if (typeof v !== 'boolean') {
        errors.push(`features.${k} is not a boolean`)
      }
    }
  }

  // killswitches.* — same boolean rule.
  const killswitches = cfg['killswitches']
  if (isPlainObject(killswitches)) {
    for (const [k, v] of Object.entries(killswitches as Record<string, unknown>)) {
      if (typeof v !== 'boolean') {
        errors.push(`killswitches.${k} is not a boolean`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isProbability(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

/**
 * Type guard — narrows `unknown` to `RemoteConfigResponse` after validation.
 * Useful at callsite to satisfy TypeScript without a manual cast.
 */
export function isRemoteConfigResponse(v: unknown): v is RemoteConfigResponse {
  return validateRemoteConfig(v).valid
}
