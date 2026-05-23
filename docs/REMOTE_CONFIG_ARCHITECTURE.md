# Remote Config Architecture — Internal Developer Guide

## Overview

The Pulse SDK is driven entirely by a remote configuration fetched from the backend at
`POST /v1/sdk-config`. Every feature toggle, sampling rate, transport route, security
rule, and killswitch is controlled by this config at runtime. **Local hardcoding is
eliminated.**

## Config Hierarchy (merge priority)

```
BAKED_IN_REMOTE_CONFIG (safe defaults)
  ↓ overridden by
Remote Config (from /v1/sdk-config)
  ↓ overridden by
User Options (from pulse.init({ ... }))
```

`ConfigManager` implements this merge in `mergeWithUserOptions()`. The result is an
immutable, frozen `RemoteConfigResponse` snapshot.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     pulse.init()                         │
│  1. ConfigManager.initialize() — fetch + merge + freeze  │
│  2. VersionPolicy.enforce() — block/degrade/ok           │
│  3. KillswitchEngine.initialize()                        │
│  4. FeatureController.initialize()                       │
│  5. SamplingEngine.initialize()                          │
│  6. LimitsEngine.initialize()                            │
│  7. SecurityScrubber.initialize()                        │
│  8. TransportRouter.initialize()                         │
│  9. Register subsystems via FeatureController             │
│ 10. ConfigManager.startRefreshLoop()                     │
└──────────────────────────────────────────────────────────┘
```

## Key Modules

### ConfigManager (`src/core/config-manager.ts`)
- Singleton. Fetches config with 3-second timeout.
- Request body includes `sdkVersion`, `service`, `environment`, `runtime`, `capabilities`.
- Provides `getConfig()` → frozen `RemoteConfigResponse` snapshot.
- `startRefreshLoop()` uses `cache.ttlSeconds` interval.
- On each refresh: diffs via `ConfigDiffer`, notifies all listeners.

### ConfigDiffer (`src/core/config-differ.ts`)
- `diffConfigs(old, new)` → `ConfigDiff` with per-section boolean flags.
- Used by refresh loop to detect which subsystems need reconfiguration.

### VersionPolicy (`src/core/version-policy.ts`)
- `enforce(sdkConfig.versionPolicy)` → `{ status, message }`.
- `blocked`: SDK enters no-op mode (version in `blockedVersions`).
- `force_upgrade`: SDK throws error (below minimum + `forceUpgrade: true`).
- `degraded`: SDK runs errors + logs only (below minimum).
- `ok`: Full operation.

### KillswitchEngine (`src/core/killswitch-engine.ts`)
- 7 independent killswitches: `disableSDK`, `disableTracing`, `disableMetrics`,
  `disableTransport`, `disableProfiling`, `disableErrors`, `disableLogs`.
- Reactive handlers: subsystems register `shutdown()`/`startup()` callbacks.
- On config refresh: flipped switches trigger handlers immediately.

### FeatureController (`src/core/feature-controller.ts`)
- 14 feature flags controlling subsystem instantiation.
- If a feature is `false`, its subsystem class is **never instantiated** (saves CPU/memory).
- Degraded mode: only `errors` and `logging` allowed.

### SamplingEngine (`src/core/sampling-engine.ts`)
- FNV-1a 32-bit hash for deterministic sampling (same traceId → same decision everywhere).
- Per-route overrides with longest-prefix-match.
- Separate rates: `traces`, `errors`, `profiles`, `replays`.

### LimitsEngine (`src/core/limits-engine.ts`)
- Token-bucket rate limiter (`maxEventsPerSecond`).
- Attribute trimming (`maxAttributesPerEvent`, `maxAttributeLength`).
- Payload size check (`maxPayloadSize`).
- Breadcrumb cap (`maxBreadcrumbs`).

### SecurityScrubber (`src/processors/security-scrubber.ts`)
- Header scrubbing (case-insensitive) → `[Redacted]`.
- Body field scrubbing (recursive, nested objects) → `[Redacted]`.
- Query parameter stripping from URLs.
- PII detection: emails → `[email]`, phones → `[phone]`, IPs → `[ip]`.
- Applied in event pipeline Step 5, before enqueue.

### TransportRouter (`src/transport/transport-router.ts`)
- 8 independent route managers: traces, errors, logs, metrics, profiles, replays, crons, envelope.
- Each route has its own queue, batching, retry, circuit breaker, and gzip compression.

## How to Add a New Remote-Configurable Field

1. **Add the field to the type** in `src/types/config.ts` under the appropriate interface
   (e.g., `TracingRemoteConfig`, `FeaturesConfig`).

2. **Add a baked-in default** in `src/constants/defaults.ts` → `BAKED_IN_REMOTE_CONFIG`.

3. **Read the field** in the appropriate module:
   - Feature toggle → `FeatureController`
   - Sampling rate → `SamplingEngine`
   - Limit → `LimitsEngine`
   - Security rule → `SecurityScrubber`
   - Killswitch → `KillswitchEngine`

4. **Handle config refresh** — add a `handleConfigChange()` handler if the field needs
   dynamic updates without restart.

5. **Write a test** in the appropriate test file under `tests/unit/`.

## Testing

```bash
# Type check
npx tsc --noEmit

# Build and run unit tests
npx tsc -p tsconfig.test.json
node --test dist-tests/tests/unit/*.test.js
```

All tests use Node.js built-in `node:test` runner — zero test framework dependencies.
