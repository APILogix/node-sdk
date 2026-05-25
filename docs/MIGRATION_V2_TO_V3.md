# Migrating from Pulse SDK v2 to v3

v3 is a **major** release. Most apps won't need code changes, but anyone reaching into the SDK's internals (engines, advanced types) will. This guide walks through every breaking change in order of likelihood you'll hit it.

---

## TL;DR

If your code looks like this:

```ts
import { init, monitorMiddleware, captureError } from '@vikasbaplawat1/pulse-sdk'

await init({ apiKey: process.env.PULSE_API_KEY! })
app.use(monitorMiddleware())
captureError(err)
```

**You don't need to change anything.** The public capture / context / scope / instrumentation APIs are byte-for-byte compatible with v2.

If you import from `'@vikasbaplawat1/pulse-sdk'` but reach for engines like `KillswitchEngine`, `SamplingEngine`, `ConfigManager`, etc., read on.

---

## What changed at a high level

1. **Backend now controls everything.** The SDK ships with safe defaults but expects the backend to send a `RemoteConfigResponse` per the v3 schema. Plan tiers (`free` / `pro` / `enterprise`) are gone from the SDK.
2. **Wire schema rewritten.** `security` → `privacy`, `cache` → `runtime`, `transport.endpoints` → `transport.routes`, schema-version negotiation, per-route per-event-type sampling.
3. **Internal engines moved to a sub-path.** Power users who imported `KillswitchEngine` etc. from the main entry now import from `@vikasbaplawat1/pulse-sdk/internals`.
4. **Plan logic neutralized.** No more `[Plan: free] Request monitoring requires a Pro plan` warnings. The SDK doesn't know what plan you're on.

---

## Breaking changes

### 1. Internal engines moved to sub-path

**v2:**
```ts
import { KillswitchEngine, SamplingEngine, ConfigManager } from '@vikasbaplawat1/pulse-sdk'
```

**v3:**
```ts
import { KillswitchEngine, SamplingEngine, ConfigManager } from '@vikasbaplawat1/pulse-sdk/internals'
```

The main entry now exports only the public API: `init`, `createSDK`, `flush`, `shutdown`, the capture functions, scope APIs, instrumentation helpers, and types. Everything else lives in `/internals` with no stability guarantees.

### 2. Remote config schema renames

The wire format your backend serves at `POST /v1/sdk-config` changed:

| v2 path | v3 path |
|---------|---------|
| `security` | `privacy` |
| `security.scrubbing.bodyFields` + `queryParams` | `privacy.scrubbing.fields` (single list) |
| `cache` | `runtime` |
| `cache.ttlSeconds` | `runtime.configTtlSeconds` |
| `transport.endpoints` | `transport.routes` |
| `tracing` (block) | gone — folded into `privacy.capture` + SDK-internal defaults |
| `errors` / `logging` / `profiling` (blocks) | gone — folded into SDK-internal defaults |
| `versionPolicy` | gone — backend can return HTTP 426 instead |
| `limits.maxAttributesPerEvent` | renamed to `limits.maxSpanAttributes` |
| `limits.maxEventsPerSecond` / `maxBreadcrumbs` | gone (moved to load shedder + init options) |

**New required field:** `schemaVersion: 1`. The SDK refuses configs with a higher major.

**New top-level field:** `features.requestCapture` (independent of `features.tracing`).

**New sampling shape:** `sampling.routes["/path"]` is now an object `{ traces, requests, errors, profiles, replays, metrics }` — each rate is independent per event type. A rate of 0 effectively replaces the v2 `tracing.ignoredRoutes` array.

### 3. Plan tier removed from SDK

**v2:**
```ts
const config = client.config
console.log(config.plan)             // 'free' | 'pro' | 'enterprise'
console.log(config.planFeatures.allowTracing)
```

**v3:** the types still exist but are stubs. `plan` is always `'enterprise'` and every `planFeatures.*` field is unrestricted. Don't rely on these — they'll be removed in v5.

### 4. Plan-based warnings gone

v2 logged:
```
[Pulse] WARN: [Plan: free] Request monitoring requires a Pro plan
```

v3 doesn't. The backend decides what features run.

### 5. Bootstrap state machine

A new `ConfigState` enum is exposed via `ConfigManager.getInstance().getState()`:

- `Pending` — `init()` hasn't run yet
- `SafeDefaults` — `init()` ran but no valid remote config (transport off, sampling 0, all features off)
- `Live` — at least one valid remote fetch has completed

Subsystems that previously emitted telemetry during the bootstrap window will now correctly drop it as `safe_defaults` until the backend is reachable.

### 6. Config validation is strict

The SDK now validates the shape of every remote-config response before applying it. A response that's missing `features`, has a non-boolean `tracing` flag, or uses an unsupported `schemaVersion` is **refused** and the SDK falls back to baked-in defaults.

You'll see a clear log line if this happens:
```
[Pulse] WARN: ConfigManager: Failed to fetch remote config: Remote config validation failed: features.tracing is not a boolean
```

### 7. Safety ceilings clamp every numeric

Every numeric value the backend sends is clamped to a hard SDK-side ceiling. A typo'd config like `"maxQueueSize": 1_000_000_000` gets coerced to `100_000` (the ceiling) silently. See `src/constants/defaults.ts` → `SAFETY_CEILINGS`.

This is **good** — your host process is protected from OOM regardless of what your control plane sends. But if you previously relied on enormous queue sizes, lower them to within ceilings.

---

## What didn't change

- `init()`, `createSDK()`, `flush()`, `shutdown()`, `getConfig()`
- `captureError()`, `captureRequest()`, `captureMessage()`, `captureEvent()`, `captureMetric()`
- All `incrementCounter` / `setGauge` / `recordHistogram` / `addUpDownCounter`
- `monitorMiddleware()` for Express, `fastifyPulsePlugin` for Fastify
- All `registerAutoInstrumentations` and `create*Instrumentation` exports
- Scope API: `setUser`, `setTag`, `setExtra`, `withScope`, `getScopeData`, etc.
- Tracing API: `startSpan`, `withSpan`, `withSpanSync`, `getActiveSpan`, `flushTracer`
- Context propagation: `extractTraceContext`, `injectTraceContext`
- Public types: `SDKEvent`, `RequestEvent`, `ErrorEvent`, `EventReceipt`, `Breadcrumb`, etc.
- All public init options on `SDKInitOptions`
- Logger control: `setLogger`, `setDebugMode`, `setLogLevel`

---

## Step-by-step migration

### Step 1: Update package version
```bash
npm install @vikasbaplawat1/pulse-sdk@3
```

### Step 2: Move internals imports
Search your codebase for any of:
```
KillswitchEngine, SamplingEngine, FeatureController, LimitsEngine,
ConfigManager, SecurityScrubber, TransportRouter, getPlanDefaults,
isFeatureAllowed, EventLoopLagMonitor, errorDeduplicator,
persistentStorage, sourceMapResolver, metricsRegistry, otelMetrics
```

If any of these are imported from `'@vikasbaplawat1/pulse-sdk'`, change to `'@vikasbaplawat1/pulse-sdk/internals'`.

### Step 3: Update your backend's config response

If your backend serves `/v1/sdk-config`:

```diff
{
+  "schemaVersion": 1,
   "sdk": { "projectId": "...", "environment": "production" },
   "features": {
     "tracing": true,
+    "requestCapture": true,
     "errors": true,
     // ...
   },
   "sampling": {
     "traces": 0.1,
+    "requests": 1.0,
     "routes": {
-      "/health": 0,
+      "/health": { "traces": 0, "requests": 0 }
     }
   },
-  "security": {
+  "privacy": {
     "scrubbing": {
       "headers": [...],
-      "bodyFields": [...],
-      "queryParams": [...]
+      "fields": [...]
     }
   },
   "transport": {
-    "endpoints": {
+    "routes": {
       "errors": { "url": "..." }
     }
   },
-  "cache": { "ttlSeconds": 300 },
+  "runtime": { "configTtlSeconds": 300, "staleWhileRevalidate": true },
-  "tracing": { ... },
-  "errors": { ... },
-  "logging": { ... },
-  "profiling": { ... },
-  "versionPolicy": { ... }
}
```

### Step 4: Drop dependencies on plan logic

If your code reads `config.plan` or `config.planFeatures`, remove it. The values in v3 are stubs.

### Step 5: Test
Run your test suite. The most common failure is a broken type import; the second is custom code reading `config.security.*`.

---

## Where to look when things go wrong

| Symptom | Likely cause |
|---------|--------------|
| TypeScript: `Module has no exported member 'KillswitchEngine'` | Step 2 not done — import from `/internals` |
| Runtime: `transport.routes is missing` | Backend still on v2 schema. Update step 3. |
| Runtime: `Remote config schema version 2 is newer than SDK-supported 1` | Backend has a newer schema. Upgrade SDK or downgrade backend response. |
| `[Plan: free] ...` warnings stopped appearing | Expected. v3 doesn't have plans. |
| Events stop arriving at backend on init | Check `ConfigManager.getInstance().getState()` — if `SafeDefaults`, transport is off until backend reachable. |
| Backend gets garbage from `POST /v1/sdk-config` | Check the new request body — it now sends `schemaVersion: 1` so the backend can choose its response format. |

---

## Performance after upgrade

The v3 capture path is slightly slower than the post-optimization v2 path because **every event now passes through more gates** (sampling per event type, feature controller, killswitch). The latest v3 stress numbers (50k events, same hardware):

```
captureRate = 64,103 /s
captureMs   = 780 ms
shutdownMs  = 2,052 ms
received    = 38,030 events       ← was 13,000 in v2
peakHeap    = 78.8 MB
```

Capture throughput is lower than v2's optimized 210k/s — the trade-off is **3× more events actually reaching the backend** because the v3 transport routes are properly drained per event type. For most workloads this is the better trade.

---

## Reporting issues

If something doesn't work after this migration and isn't covered above, open an issue with:
- The exact import that failed (or the runtime error)
- Your backend's `POST /v1/sdk-config` response
- Output of `ConfigManager.getInstance().getState()`
