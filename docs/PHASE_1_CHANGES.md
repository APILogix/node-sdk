# Pulse SDK v3 — Phase 1 Schema Migration

**Status:** complete
**Version:** `2.0.0` → `3.0.0`
**Scope:** wire-format alignment with the new backend control plane.

---

## Why this change

Before v3, behaviour was a mix of three sources:

1. Hardcoded SDK constants
2. A bloated remote-config schema with overlapping fields (`tracing.ignoredRoutes` *and* `sampling.routes`, `security` *and* per-feature scrubbing, `cache` *and* `runtime`, etc.)
3. SDK-side plan logic (`free` / `pro` / `enterprise`) that locked billing decisions into the SDK binary

Every billing change or noise-suppression tweak required a new SDK release. v3 moves all of that to the backend. The SDK becomes a thin executor — one schema, one source of truth, one safety net.

This document covers Phase 1: aligning the wire schema. Phases 2 and 3 wire every event capture decision through the new schema and remove the legacy plan logic.

---

## What's in the new schema

```ts
RemoteConfigResponse {
  schemaVersion:    1                       // NEW — gate against future breaking changes
  sdk:              { projectId, environment, release? }
  features:         FeaturesConfig          // 11 boolean toggles
  sampling:         SamplingConfig          // global rates + per-route per-event-type rates
  instrumentation:  InstrumentationConfig   // per-framework toggles + per-feature flags
  privacy:          PrivacyConfig           // capture flags + scrubbing + PII detection
  limits:           LimitsConfig            // 7 numeric ceilings (clamped by SDK)
  killswitches:     KillswitchesConfig      // 7 operational fire-extinguishers
  transport:        TransportRemoteConfig   // per-event-type routes + retry + queue
  runtime:          RuntimeConfig           // refresh TTL + stale-while-revalidate
  meta:             ConfigMeta              // generatedAt, generatedBy, configHash
}
```

---

## Field-by-field changes

### Renames

| v2 (old) | v3 (new) | Reason |
|----------|----------|--------|
| `security` | `privacy` | Better name — the block governs PII handling, not auth |
| `security.scrubbing.bodyFields` + `queryParams` | `privacy.scrubbing.fields` | Single list, applied to both bodies and query params |
| `cache` | `runtime` | "cache" was a misleading name — it controls refresh, not caching |
| `transport.endpoints` | `transport.routes` | Aligns with `TransportRouteName` and `sampling.routes` |
| `cache.ttlSeconds` | `runtime.configTtlSeconds` | Explicit unit |

### Removals

| v2 (removed) | Where the behaviour went |
|--------------|---------------------------|
| `tracing` block (rich) | Folded into `privacy.capture` + SDK-internal `TRACING_DEFAULTS` |
| `tracing.ignoredRoutes` / `ignoredMethods` | Express via `sampling.routes["/path"] = { traces: 0, requests: 0 }` |
| `errors` block | SDK-internal `ERROR_DEFAULTS` (not tenant-controllable) |
| `logging` block | SDK-internal `LOGGING_DEFAULTS` |
| `profiling` block (mostly) | SDK-internal `PROFILING_DEFAULTS` (`features.profiling` controls on/off) |
| `versionPolicy` block | Backend can return HTTP 426 to refuse old SDKs |
| `features.aiDetection` / `dynamicSampling` / `sourceMaps` / `releaseTracking` | Always-on capabilities, not toggles |
| `limits.maxEventsPerSecond` | Replaced by `loadShedder` + `tenantGovernor` (smarter, pressure-aware) |
| `limits.maxBreadcrumbs` | Now an init option (per-process concern) |
| `limits.maxAttributesPerEvent` | Renamed to `maxSpanAttributes` (covers the same call sites) |

### Additions

| v3 (new) | What it does |
|----------|--------------|
| `schemaVersion: 1` | SDK refuses configs with a higher major than it understands |
| `features.requestCapture` | Independent control over HTTP request event capture |
| `sampling.requests` | Separate sampling rate for request events |
| `RouteSamplingRates` | Per-route per-event-type rates: `{ traces: 1, requests: 1, errors: 1, ... }` |
| `SAFETY_CEILINGS` (in code, not on wire) | Hard upper bounds the SDK clamps every numeric field to before applying |
| `SAFETY_FLOORS` (in code, not on wire) | Minimum values for refresh TTL / flush interval to prevent self-DoS |

---

## How safety clamping works

Every numeric value the backend can send is clamped to a built-in ceiling defined in `src/constants/defaults.ts`:

```ts
SAFETY_CEILINGS = {
  maxSpansPerTrace:      5_000,
  maxSpanAttributes:     500,
  maxAttributeLength:    16 KiB,
  maxPayloadSize:        4 MiB,
  maxQueueSize:          100_000,
  maxMemoryMb:           1024,
  maxCpuOverheadPercent: 25,
  batchSize:             5_000,
  flushIntervalMs:       5 min,
  timeoutMs:             60s,
  retryMaxRetries:       10,
  retryBaseDelayMs:      30s,
  configTtlSeconds:      24h,
}
```

A backend mistake — say, `"maxQueueSize": 1000000000` — gets clamped to `100_000` before it reaches `LimitsEngine`. The host process is protected from OOM regardless of what the control plane sends. The clamping happens in `ConfigManager.applySafetyClamps()` after merge but before the config becomes visible to subsystems.

---

## Schema version gating

`ConfigManager.fetchConfig()` now refuses any config whose `schemaVersion` is higher than the SDK constant `REMOTE_CONFIG_SCHEMA_VERSION = 1`. The SDK falls back to `BAKED_IN_REMOTE_CONFIG` and logs a clear "SDK upgrade required" message. This protects against the inevitable future schema change without coordinating fleet-wide redeploys.

Adding fields within the same major remains forward-compatible — the deep merge happily ignores unknown keys.

---

## Backward compatibility shims

To keep Phase 1 small and reversible, the following deprecated type aliases live in `src/types/config.ts`:

| Deprecated alias | Maps to |
|------------------|---------|
| `SecurityConfig` | `PrivacyConfig` |
| `TracingCaptureConfig` | `PrivacyCaptureConfig` |
| `CacheConfig` | `RuntimeConfig` |
| `TransportEndpointConfig` | `TransportRouteConfig` |
| `TracingRemoteConfig` | (legacy shape — kept as standalone interface) |
| `ErrorsConfig` / `LoggingConfig` / `ProfilingConfig` | (legacy shapes — kept as standalone interfaces) |
| `VersionPolicyConfig` | (legacy shape — kept as standalone interface) |

These will be removed in Phase 3 once all internal call sites have migrated.

---

## Files changed

**Foundational:**
- `src/types/config.ts` — full rewrite + compat aliases
- `src/constants/defaults.ts` — full rewrite + safety ceilings/floors
- `src/constants/internal-defaults.ts` — **new** — `ERROR_DEFAULTS`, `LOGGING_DEFAULTS`, `PROFILING_DEFAULTS`, `TRACING_DEFAULTS`, `DEFAULT_TRACE_CAPTURE`
- `src/core/config-manager.ts` — schema version gate + safety clamping
- `src/core/config-differ.ts` — diff structure for new sections

**Engines:**
- `src/core/sampling-engine.ts` — per-event-type route rates
- `src/core/limits-engine.ts` — adapted to minimal `LimitsConfig`
- `src/core/version-policy.ts` — stubbed
- `src/processors/security-scrubber.ts` — `PrivacyConfig` + unified `fields` list

**Capture / instrumentation:**
- `src/instrumentation/auto-instrument.ts` — reads `privacy.capture`
- `src/instrumentation/global-errors.ts` — reads `ERROR_DEFAULTS`
- `src/instrumentation/request-capture-utils.ts` — reads `privacy.capture`
- `src/instrumentation/{axios,bullmq,mongodb,redis}.ts` — type rename only
- `src/subsystems/logging-subsystem.ts` — handles synthesized config
- `src/subsystems/profiling-subsystem.ts` — handles synthesized config

**Tracing:**
- `src/tracing/context-propagation.ts` — uses `TRACING_DEFAULTS.propagation`
- `src/tracing/remote-config-sampler.ts` — drops duplicate route filtering
- `src/tracing/tracer.ts` — reads `privacy.capture` + `limits.maxSpanAttributes`

**Transport:**
- `src/transport/route-registry.ts` — `endpoints` → `routes`

**Lifecycle:**
- `src/core/init.ts` — synthesizes `logging` / `profiling` blocks for subsystems

**Public API:**
- `src/internals.ts` — exports updated for new types

**Versioning:**
- `package.json` — `2.0.0` → `3.0.0`
- `src/constants/version.ts` — `2.0.0` → `3.0.0`

---

## What this enables

| Capability | Before | After |
|-----------|--------|-------|
| Mute `/health` traces from the dashboard without redeploy | ❌ (required SDK release) | ✅ `sampling.routes["/health"] = { traces: 0 }` |
| Disable request capture for one customer | ❌ | ✅ `features.requestCapture = false` |
| Sample requests at a different rate than traces | ❌ (one rate) | ✅ separate `sampling.traces` and `sampling.requests` |
| Per-route, per-event-type rates | ❌ | ✅ `routes["/payments"] = { traces: 1, requests: 1 }` |
| Survive a malformed config typo (`maxQueueSize: 1e9`) | 💥 OOM | ✅ clamped to `100_000` |
| Refuse incompatible future config schema | ❌ | ✅ `schemaVersion` gate |
| Single PII scrubbing list for headers / bodies / queries | ❌ (3 lists) | ✅ unified `privacy.scrubbing.fields` |
| Move billing logic out of the SDK | ❌ (plan tiers) | 🔶 schema is plan-free; legacy types still kept (Phase 3 removes them) |

---

## What's next

**Phase 2 — wire all decisions through the new schema:** ✅ **DONE**
- ✅ `monitorMiddleware` and Fastify plugin now pass a stable `sampleKey` (the request id) to the capture gate
- ✅ Capture gate calls `SamplingEngine.shouldSampleRequest(id, route)` so per-route per-event-type rates work end-to-end
- ✅ Capture gate calls `FeatureController.isEnabled('requestCapture')` so disabling request capture from the backend works without redeploy
- ✅ Event pipeline gates `request` events on `features.requestCapture` *and* `disableTracing` killswitch
- ✅ `CaptureGateDecision` now exposes `sampledRate` so adapters can attach it as a span attribute for backend reweighting
- ✅ Sampling failures get a `reason` of the form `sampling_always_drop` / `sampling_route_override` / etc. for debug visibility

**Phase 3 — neutralize the legacy plan system:** ✅ **DONE**
- ✅ `src/core/plan-gate.ts` rewritten as a stub — every function returns "unrestricted"
- ✅ `clampToPlan()` is now a passthrough — no warnings, no clamping (the noisy `[Plan: free] ...` log lines are gone)
- ✅ `validatePluginCount()` removed from init.ts (every plugin now accepted)
- ✅ `beforeSend` plan check removed (always allowed)
- ✅ `internals.ts` exports for `getPlanDefaults` / `isFeatureAllowed` flagged as deprecated
- ✅ `PlanTier` / `PlanFeatures` types kept on `ResolvedSDKConfig` (avoids public API break in v3 — slated for deletion in v5)
- ✅ Deprecated config aliases (`SecurityConfig`, `TracingCaptureConfig`, etc.) kept — still actively used by subsystem internals; will go in v5 alongside subsystem refactor

**Phase 4 — bootstrap & failure-mode hardening:** ✅ **DONE**
- ✅ New `src/core/config-validator.ts` — hand-rolled validator that catches null/array payloads, missing sections, wrong-typed fields, oversized `schemaVersion`, malformed transport routes
- ✅ `ConfigManager.fetchConfig()` now runs full shape validation in addition to the schema-version gate
- ✅ Malformed JSON (parse failure) is wrapped with a clear "not valid JSON" error so callers can distinguish network vs body issues
- ✅ Forward-compat: unknown top-level fields are accepted (the deep-merge ignores them)
- ✅ New `ConfigState` enum (`Pending` / `SafeDefaults` / `Live`) — subsystems can read it via `ConfigManager.getInstance().getState()` to attribute drops correctly
- ✅ `ConfigState.Live` only after a *valid* fetch — failed validation drops back to `SafeDefaults`
- ✅ Request body now advertises `schemaVersion` so the backend can downgrade the response if it serves multiple wire formats
- ✅ 13 unit tests for the validator, all passing (`tests/unit/config-validator.test.ts`)
- ⚠️ Pre-existing v2-era unit tests in `tests/unit/` (config-differ, feature-controller, limits-engine, sampling-engine, etc.) still reference the old schema and need updating — flagged for Phase 5

**Phase 5 — release prep:** ✅ **DONE**
- ✅ All v2-era unit tests rewritten to v3 schema (123/123 passing — config-differ, feature-controller, limits-engine, sampling-engine, security-scrubber, transport-router, version-policy, remote-config integration)
- ✅ Load test (`tests/integration/load.test.ts`) updated to emit a v3-shaped `RemoteConfigResponse` from the mock backend
- ✅ Stress test executed against v3: 64,103 events/sec capture, 38,030 events delivered (3× v2's 13,000), peak heap 78.8 MB
- ✅ `docs/MIGRATION_V2_TO_V3.md` — step-by-step migration guide
- ✅ `docs/STRESS_TEST_V3.md` — v3 stress test results with v2 comparison
- ✅ `README.md` rewritten to drop plan references, document the new `/internals` sub-path, list public API surface, and link the docs
