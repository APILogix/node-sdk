# Features vs Entitlements Gateway Guide

This document provides a comprehensive technical reference on how **`features`** and **`entitlements`** operate within the Pulse Node.js SDK and Control Plane.

---

## 1. Architectural Philosophy & Overview

The Pulse SDK employs a **3-Tier Configuration & Governance Gateway** to decouple runtime process resource management from subscription plan enforcement:

```
                          ┌────────────────────────┐
                          │   Incoming Telemetry   │
                          │  (API call / Auto hook)│
                          └───────────┬────────────┘
                                      │
                                      ▼
             ┌─────────────────────────────────────────────────┐
             │ Tier 1: FeatureController (features.*)           │
             │ Is the subsystem instantiated in Node.js memory?│
             └────────────────────────┬────────────────────────┘
                                      │ YES (Subsystem alive)
                                      ▼
             ┌─────────────────────────────────────────────────┐
             │ Tier 2: EntitlementGate (entitlements.*)         │
             │ Is this API/telemetry allowed by customer plan? │
             └────────────────────────┬────────────────────────┘
                                      │ YES (Entitled)
                                      ▼
             ┌─────────────────────────────────────────────────┐
             │ Tier 3: KillswitchEngine (killswitches.*)       │
             │ Is there an emergency operational killswitch on?│
             └────────────────────────┬────────────────────────┘
                                      │ NO (Not killed)
                                      ▼
             ┌─────────────────────────────────────────────────┐
             │ SamplingEngine & TenantGovernor                 │
             │ (Rate-limiting, Quotas & Ingestion Routing)     │
             └─────────────────────────────────────────────────┘
```

### Why Both Exist Independently

| Dimension | `features` (Subsystem Controller) | `entitlements` (Capability Gateway) |
| :--- | :--- | :--- |
| **Primary Concern** | **Resource & Memory Management** in Node.js. | **Billing & Subscription Plan** permissions. |
| **Question Answered** | *"Should the SDK allocate memory, start workers, or hook process events for this subsystem?"* | *"Does the customer's tier permit using this developer API or ingestion pipeline?"* |
| **When `false`** | Subsystem class is **never instantiated** (0 CPU / 0 RAM overhead). | Calls become **silent no-ops**; pipeline drops events fail-safe. |
| **Granularity** | Coarse-grained (e.g. `metrics`, `tracing`). | Fine-grained (e.g. `customMetrics` vs `metrics`, `customSpans` vs `tracing`). |
| **Managed By** | [`FeatureController`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/feature-controller.ts) | [`EntitlementGate`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/entitlement-gate.ts) |

---

## 2. Deep Dive: `features` Configuration (11 Keys)

Defined in [`FeaturesConfig`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/config.ts#L46-L58), each boolean governs the lifecycle of background workers and event handlers.

```json
"features": {
  "tracing": true,
  "requestCapture": true,
  "errors": true,
  "metrics": true,
  "logging": true,
  "profiling": true,
  "gcMonitoring": true,
  "sessionReplay": true,
  "runtimeMetrics": true,
  "eventLoopMonitoring": true,
  "crons": true
}
```

### Detailed Breakdown

| Key | Type | Subsystem / Worker | Runtime Behavior |
| :--- | :--- | :--- | :--- |
| **`tracing`** | `boolean` | OpenTelemetry `NodeTracerProvider` | When `true`, initializes OTel tracer provider and hooks auto-instrumentations. When `false`, completely skips tracer instantiation. |
| **`requestCapture`** | `boolean` | HTTP Framework Adapters (Express / Fastify) | When `true`, allows HTTP middlewares to extract request metadata and body payloads. |
| **`errors`** | `boolean` | Global Error Listeners | When `true`, registers `process.on('uncaughtException')`, `process.on('unhandledRejection')`, and console error monitors. |
| **`metrics`** | `boolean` | OpenTelemetry MeterProvider & Metrics Registry | When `true`, initializes metrics aggregators and periodic meter readers. |
| **`logging`** | `boolean` | [`LoggingSubsystem`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/subsystems/logging-subsystem.ts) | When `true`, instantiates `LoggingSubsystem` class and console interceptors. |
| **`profiling`** | `boolean` | [`ProfilingSubsystem`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/subsystems/profiling-subsystem.ts) | When `true`, connects to Node.js V8 Inspector session for CPU & heap sampling. |
| **`crons`** | `boolean` | [`CronSubsystem`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/subsystems/cron-subsystem.ts) | When `true`, instantiates in-flight job monitor and timeout tracking maps. |
| **`sessionReplay`** | `boolean` | [`SessionManager`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/session/session-manager.ts) | When `true`, manages session lifecycle and replay segment buffering. |
| **`runtimeMetrics`** | `boolean` | [`AdaptivePressureMonitor`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/adaptive-pressure.ts) | Collects process memory (RSS, heapUsed, external) and CPU usage metrics. |
| **`eventLoopMonitoring`**| `boolean` | `perf_hooks` Event Loop Monitor | Measures event loop delay (p50, p90, p99 lag) to throttle load under pressure. |
| **`gcMonitoring`** | `boolean` | `PerformanceObserver` (`gc` entry type) | Tracks garbage collection pauses (major, minor, incremental) for pressure shedder. |

---

## 3. Deep Dive: `entitlements` Configuration (10 Keys)

Defined in [`EntitlementsConfig`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/config.ts#L251-L272), these keys represent backend-resolved billing capabilities.

```json
"entitlements": {
  "crons": true,
  "errors": true,
  "logging": true,
  "metrics": true,
  "tracing": true,
  "profiling": true,
  "customSpans": true,
  "customMetrics": true,
  "sessionReplay": true,
  "requestCapture": true
}
```

### Direct Method & Hook Attachment Mapping

| Entitlement Key | Direct Methods & Functions Gated | Automatic Hooks & Pipeline Routes | Behavior When `false` (Revoked) |
| :--- | :--- | :--- | :--- |
| **`customSpans`** | • `startSpan(name, opts)`<br/>• `withSpan(name, fn)`<br/>• `withSpanSync(name, fn)` | `EventEmitter` async context patching | Returns a non-recording **`NoopSpan`**. User code executes normally, but zero span data is emitted. |
| **`tracing`** | N/A (developer uses `customSpans`) | • `http` / `https`<br/>• `express` / `fastify`<br/>• `pg` / `mysql2`<br/>• `prisma` / `redis`<br/>• `mongodb` / `bullmq` | Auto-instrumentations are suppressed; automatic distributed trace spans are not created. |
| **`customMetrics`**| • `incrementCounter(name)`<br/>• `setGauge(name, val)`<br/>• `recordHistogram(name, val)`<br/>• `addUpDownCounter(name)`<br/>• `captureMetric(name, val)` | Ingest route: `POST /api/v1/metrics` | `admitMetric()` returns `false`. Metric recording calls silently exit in O(1) time without recording. |
| **`metrics`** | Automatic runtime metric collectors | Ingest route: `POST /api/v1/metrics` | Pipeline drops `type: 'metric'` events before transport routing. |
| **`logging`** | • `captureLog(level, msg, ...args)`<br/>• `LoggingSubsystem.captureLog()` | `console.log/info/warn/error` interception wrappers | `captureLog()` early-returns immediately. Pipeline drops `type: 'log'` events. |
| **`profiling`** | • `startProfile(profileId)`<br/>• `stopProfile(profileId)` | Automatic trace profiling triggers | `startProfile()` returns `false`. V8 inspector sessions are not engaged. |
| **`crons`** | • `captureCronCheckIn(slug, status)`<br/>• `CronSubsystem.checkIn()` | Ingest route: `POST /api/v1/checkins` | `captureCronCheckIn()` exits immediately; pipeline drops `type: 'cron_checkin'` events. |
| **`sessionReplay`**| • `captureReplay(sessionId, segId, events)` | Ingest route: `POST /api/v1/replays` | `captureReplay()` exits immediately; pipeline drops `type: 'replay'` events. |
| **`requestCapture`**| Framework middleware request handlers | Ingest route: `POST /api/v1/requests` | `evaluateCaptureGate()` returns `denied('request_capture_not_entitled')`. |
| **`errors`** | Automatic error listeners | `process.on('uncaughtException')`<br/>`process.on('unhandledRejection')` | Automatic error listeners are disabled. |

---

## 4. Ungated Core APIs (Plan-Agnostic)

The following baseline APIs are **never gated by entitlements** and are guaranteed to work on all subscription tiers:

1. **`captureError(error, context)`**: Explicit manual error capture.
2. **`captureMessage(message, level)`**: Manual message event capture (`type: 'message'`).
3. **Context / Scope APIs**: `setUser()`, `setTag()`, `setTags()`, `setExtra()`, `setContext()`, `addBreadcrumb()`, `clearBreadcrumbs()`.
4. **Lifecycle APIs**: `flush()`, `shutdown()`, `isInitialized()`.

---

## 5. Compatibility & Truth Matrix (All 4 Operational States)

```
                       ┌──────────────────────┐
                       │  Features: Enabled?  │
                       └──────────┬───────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 ▼ YES                             ▼ NO
        ┌──────────────────┐              ┌──────────────────┐
        │Entitlements: ON? │              │Entitlements: ON? │
        └───┬──────────┬───┘              └───┬──────────┬───┘
            │          │                      │          │
        YES ▼       NO ▼                  YES ▼       NO ▼
       ┌─────────┐┌─────────┐            ┌─────────┐┌─────────┐
       │ State 1 ││ State 2 │            │ State 3 ││ State 4 │
       │ Active  ││ No-Op   │            │ No-Op   ││ Dead    │
       └─────────┘└─────────┘            └─────────┘└─────────┘
```

| State | `features` | `entitlements` | Subsystem in Node.js | Developer APIs | Automatic Hooks | Pipeline Delivery |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **State 1: Full Active** | `true` | `true` | **Active & Running** | **Captures & Records** | **Emits Spans/Events** | **Delivered** to Backend Routes |
| **State 2: Unlicensed** | `true` | `false` | Alive in memory | **Silent No-Op** (returns `false` or `NoopSpan`) | Suppressed / Dropped | **Dropped** at Gate 3.1 in EventPipeline |
| **State 3: Subsystem Off**| `false` | `true` | **Not Instantiated** (0 RAM) | **Silent No-Op** (finds `null` instance) | Not Registered | **Dropped** at Gate 3 in EventPipeline |
| **State 4: Complete Off** | `false` | `false` | **Not Instantiated** (0 RAM) | **Silent No-Op** | Not Registered | **Dropped** |

---

## 6. Remote Config Schema Validation Rules

The SDK validates the entire configuration document at startup (`POST /v1/init`) using [`ConfigValidator`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts). 

### Validation Invariants
1. **Zero Partial Configs**: The backend must supply all 11 keys in `features` and all 10 keys in `entitlements`. Missing any key rejects the entire snapshot.
2. **Atomic Hot Reload**: When `/v1/sdk-config` is fetched on `change: true`, [`ConfigApplier`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-applier.ts) computes diffs and dynamically invokes:
   - `FeatureController.handleConfigChange()`: Instantiates new subsystems or tears down disabled ones.
   - `EntitlementGate.handleConfigChange()`: Flips hot-path API admission flags without disrupting in-flight traces.
