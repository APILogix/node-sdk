# SDK Complete Audit — Event Types, Transport, Sampling & Remote Control

## 1. Event Types & Transport Configuration

The SDK has **10 event types** routed to **10 transport routes**:

| Event Type | `type` discriminator | Transport Route | Endpoint Path | Priority |
|---|---|---|---|---|
| Error | `error` | `errors` | `/v1/errors` | **critical** |
| Message | `message` | `events` | `/v1/events` | **high** |
| Span | `span` | `spans` | `/v1/spans` | normal |
| Trace (aggregated) | `trace` | `traces` | `/v1/traces` | **high** |
| Request | `request` | `requests` | `/v1/requests` | **high** |
| Metric | `metric` | `metrics` | `/v1/metrics` | low |
| Log | `log` | `logs` | `/v1/logs` | normal |
| Profile | `profile` | `profiles` | `/v1/profiles` | low |
| Cron Check-in | `cron_checkin` | `crons` | `/v1/checkins` | **high** |
| Replay | `replay` | `replays` | `/v1/replays` | low |

---

## 2. Batching Configuration (Per Route)

| Route | Max Batch Size | Flush Interval (ms) | Min Batch Size | Queue Max Size |
|---|---|---|---|---|
| `errors` | 100 | 1,000 (1s) | 1 | 10,000 |
| `events` | 100 | 1,000 (1s) | 1 | 10,000 |
| `traces` | 500 | 5,000 (5s) | 10 | 50,000 |
| `spans` | 500 | 5,000 (5s) | 10 | 50,000 |
| `requests` | 500 | 5,000 (5s) | 10 | 50,000 |
| `metrics` | 1,000 | 10,000 (10s) | 50 | 25,000 |
| `logs` | 200 | 10,000 (10s) | 10 | 25,000 |
| `profiles` | 5 | 30,000 (30s) | 1 | 5,000 |
| `crons` | 1 | 0 (immediate) | 1 | 1,000 |
| `replays` | 5 | 10,000 (10s) | 1 | 5,000 |

**Key behaviors:**
- `crons` is immediate delivery (batchSize=1, flushInterval=0) — no batching delay
- `errors` flush every 1s with batch of 1 minimum — near-real-time error delivery
- `metrics` are the most heavily batched (1000 per batch, 10s interval)
- `profiles` are rare and large — tiny batch size (5), long flush interval (30s)

---

## 3. Connection Limits (Per Route)

| Route | Max Concurrent Connections |
|---|---|
| `traces` | 50 |
| `spans` | 50 |
| `requests` | 50 |
| `errors` | 30 |
| `events` | 30 |
| `metrics` | 20 |
| `logs` | 20 |
| `replays` | 10 |
| `profiles` | 5 |
| `crons` | 5 |

---

## 4. Sampling Configuration

Sampling is **deterministic** (FNV-1a hash) — same ID = same decision across all SDK instances.

| Sampling Family | Key Used for Hash | Per-Route Override? |
|---|---|---|
| `traces` | traceId | Yes (longest prefix match) |
| `requests` | requestId | Yes |
| `errors` | eventId | Yes |
| `profiles` | traceId | Yes |
| `replays` | sessionId | No (session-level only) |
| `metrics` | metricId | Yes |

**Not sampled (always pass through):**
- `messages` — no dedicated sampling key
- `logs` — no dedicated sampling key
- `cron_checkin` — no dedicated sampling key

These are controlled by features/entitlements/killswitches instead.

**Remote config shape:**
```json
{
  "sampling": {
    "traces": 1.0,
    "requests": 1.0,
    "errors": 1.0,
    "profiles": 0.5,
    "replays": 1.0,
    "metrics": 1.0,
    "routes": {
      "/health": { "traces": 0, "requests": 0 },
      "/api/v1/users": { "traces": 0.5 }
    }
  }
}
```


---

## 5. Transport Architecture — How Events Flow

```
User code calls captureError() / withSpan() / captureLog() / etc.
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  EVENT PIPELINE (event-pipeline.ts)                     │
│                                                         │
│  Gate 1: SDK shutting down? → reject                    │
│  Gate 1.5: Global killswitch (disableSDK)? → reject    │
│  Gate 1.6: Rate limiter (LimitsEngine)? → reject       │
│  Gate 2: Critical memory pressure? → reject (low-pri)  │
│  Gate 3: Load shedder (adaptive pressure)? → reject    │
│  Gate 4: Pre-init? → buffer in queue                   │
│                                                         │
│  Step 3: Feature flag check (FeatureController)         │
│  Step 3.25: Tenant admission (quota per window)         │
│  Step 3.5: Attribute limits (LimitsEngine)              │
│  Step 4: Normalize (fill defaults, truncate)            │
│  Step 6: Enrich (traceId, spanId, breadcrumbs)          │
│  Step 6.5: Error deduplication                          │
│  Step 7: Apply scope (user, tags, extras)               │
│  Step 7.5: Source context (error stack frames)          │
│  Step 8: Plugin processors                              │
│  Step 9: User event processors                          │
│  Step 10: beforeSend hook                               │
│  Step 11: Plugin beforeSend hooks                       │
│  Step 12: Attach metadata                               │
│                                                         │
│  Step 13: Route to TransportRouter                      │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  TRANSPORT ROUTER (transport-router.ts)                 │
│                                                         │
│  1. RouteRegistry.resolve(event)                        │
│     event.type → route mapping:                         │
│       error    → errors route                           │
│       message  → events route                           │
│       span     → spans route                            │
│       trace    → traces route                           │
│       request  → requests route                         │
│       metric   → metrics route                          │
│       log      → logs route                             │
│       profile  → profiles route                         │
│       cron_checkin → crons route                        │
│       replay   → replays route                          │
│                                                         │
│  2. Check route is configured (has real URL)            │
│  3. Enqueue in route-specific TransportEventQueue       │
│  4. BatchManager collects until batch full or timer     │
│  5. ConnectionManager sends HTTP POST (gzip)            │
│  6. HealthMonitor tracks success/failure (circuit)      │
│  7. On failure: retry (exponential backoff)             │
│  8. On exhaustion: persist to disk (fallback)           │
└─────────────────────────────────────────────────────────┘
```

**Retry behavior:**
- Retryable: network errors, HTTP 408, 429, 5xx
- Not retryable: 4xx (except 408/429)
- Backoff: exponential (configurable: exponential/linear/fixed)
- Max retries: configurable (default 3)
- Circuit breaker: per-route health tracking

**Queue overflow strategy:** `drop_oldest` (default) — when queue is full, oldest events are evicted to make room for new ones.

---

## 6. Remote Config — Full Feature Control Matrix

### 6.1 Features (subsystem on/off)

Controls whether a subsystem is **instantiated at all**. When `false`, the SDK never starts the subsystem and rejects events of that type.

| Feature Flag | Controls | Hot-swappable? |
|---|---|---|
| `features.tracing` | OTel tracer + auto-instrumentation + span events | Yes — tears down/rebuilds tracer |
| `features.requestCapture` | HTTP request event capture in middleware | Yes |
| `features.errors` | Global error handlers (uncaught/unhandled) + error events | Yes — detaches/attaches handlers |
| `features.metrics` | OTel meter provider + metric events | Yes — shuts down/restarts meter |
| `features.logging` | Logging subsystem + log events | Yes |
| `features.profiling` | CPU profiling subsystem + profile events | Yes |
| `features.crons` | Cron monitoring subsystem + check-in events | Yes |
| `features.sessionReplay` | Session manager + replay events | Yes |
| `features.runtimeMetrics` | Adaptive runtime metrics collection | Yes |
| `features.eventLoopMonitoring` | Event-loop pressure signal | Yes |
| `features.gcMonitoring` | GC pressure signal | Yes |

### 6.2 Killswitches (emergency stop)

Instantly silences a subsystem **without tearing it down**. Used for emergency operational control.

| Killswitch | Effect |
|---|---|
| `killswitches.disableSDK` | ALL events rejected. Nothing is captured. |
| `killswitches.disableTracing` | Tracer shuts down, auto-instrumentation removed, span/trace events rejected |
| `killswitches.disableMetrics` | Meter provider shuts down, metric events rejected |
| `killswitches.disableTransport` | Router rejects all sends (events queue locally but don't ship) |
| `killswitches.disableProfiling` | Profiler stops, profile events rejected |
| `killswitches.disableErrors` | Global handlers detached, error events rejected |
| `killswitches.disableLogs` | Logging subsystem stops, log events rejected |

### 6.3 Entitlements (billing gate for custom/developer APIs)

Controls whether **custom developer-facing APIs** are active. Does NOT affect automatic instrumentation.

| Entitlement | API Gated | No-op behavior when `false` |
|---|---|---|
| `entitlements.customSpans` | `startSpan()`, `withSpan()`, `withSpanSync()` | Returns non-recording noop span |
| `entitlements.customMetrics` | `incrementCounter()`, `setGauge()`, `recordHistogram()`, `addUpDownCounter()` | Call silently dropped |
| `entitlements.profiling` | `startProfile()`, `stopProfile()` | `startProfile()` returns `false` |
| `entitlements.logging` | `captureLog()` | Call silently dropped |
| `entitlements.sessionReplay` | `captureReplay()` | Call silently dropped |
| `entitlements.crons` | `captureCronCheckIn()` | Call silently dropped |
| `entitlements.requestCapture` | Automatic request capture | Middleware skips capture |
| `entitlements.tracing` | Automatic distributed tracing | Auto-spans not created |
| `entitlements.errors` | Automatic error capture | Handlers don't fire |
| `entitlements.metrics` | Automatic runtime metrics | Runtime collection stops |

**Core APIs NEVER gated (always work regardless of entitlements):**
- `captureError()` (manual)
- `captureMessage()`
- `setUser()`, `setTag()`, `setExtra()`, `setContext()`
- `addBreadcrumb()`
- `flush()`, `shutdown()`
- `getSDKHealth()`, `getConfig()`


---

## 7. What IS Remotely Controlled Today

| Control | Mechanism | Hot-reload? |
|---|---|---|
| Feature on/off per subsystem | `features.*` | Yes |
| Emergency kill per subsystem | `killswitches.*` | Yes |
| Sampling rate per event type | `sampling.traces/requests/errors/profiles/replays/metrics` | Yes |
| Sampling per route (prefix) | `sampling.routes.*` | Yes |
| Transport route URLs | `transport.routes.*.url` | Yes |
| Batch size per route | `transport.routes.*.batchSize` | Yes |
| Flush interval per route | `transport.routes.*.flushIntervalMs` | Yes |
| Timeout per route | `transport.routes.*.timeoutMs` | Yes |
| Compression per route | `transport.routes.*.compression` | Yes |
| Retry config | `transport.retry.*` | Yes |
| Queue overflow strategy | `transport.queue.overflowStrategy` | Yes |
| Privacy/capture rules | `privacy.capture.*` (headers/body/query/response/cookies) | Yes |
| Scrubbing rules | `privacy.scrubbing.*` (headers, fields) | Yes |
| PII detection | `privacy.piiDetection.*` (emails/phones/IPs) | Yes |
| Attribute limits | `limits.maxSpanAttributes`, `limits.maxAttributeLength` | Yes |
| Payload limits | `limits.maxPayloadSize` | Yes |
| Queue limits | `limits.maxQueueSize` | Yes |
| Memory cap | `limits.maxMemoryMb` | Yes |
| CPU cap | `limits.maxCpuOverheadPercent` | Yes |
| Tenant governance | `limits.tenantGovernance.*` | Yes |
| Entitlements (billing gates) | `entitlements.*` | Yes |
| Instrumentation toggles | `instrumentation.http/express/axios/mongodb/etc.` | At init only |
| Config refresh interval | `runtime.configTtlSeconds` | Yes |
| Stale-while-revalidate | `runtime.staleWhileRevalidate` | Yes |

---

## 8. What is NOT Remotely Controlled (Gaps)

These are hardcoded in the SDK and CANNOT be changed by the backend:

| Item | Current behavior | Where hardcoded |
|---|---|---|
| **Queue max sizes per route** | errors=10K, traces=50K, metrics=25K, etc. | `transport-router.ts` → `QUEUE_CONFIG` |
| **Batch defaults per route** | errors=100/1s, traces=500/5s, etc. | `transport-router.ts` → `BATCH_CONFIG` |
| **Connection limits per route** | errors=30, traces=50, profiles=5, etc. | `transport-router.ts` → `CONNECTION_LIMITS` |
| **Min batch sizes** | errors=1, traces=10, metrics=50, etc. | `transport-router.ts` → `BATCH_CONFIG.minBatchSize` |
| **Max pending pipelines** | 10,000 | `event-pipeline.ts` → `MAX_PENDING_PIPELINES` |
| **Plugin timeout** | 50ms | `event-pipeline.ts` → `PLUGIN_TIMEOUT_MS` |
| **beforeSend timeout** | 100ms | `event-pipeline.ts` → `BEFORE_SEND_TIMEOUT_MS` |
| **Source context timeout** | 250ms | `event-pipeline.ts` → `SOURCE_CONTEXT_TIMEOUT_MS` |
| **Error dedup window** | Hardcoded in deduplicator | `processors/deduplicator.ts` |
| **Max breadcrumbs** | User init option (default 100, max 1000) | Zod schema enforces max 1000 |
| **Shutdown timeout** | User init option (default 10s, max 60s) | Zod schema |
| **Safety ceilings** | maxQueueSize≤100K, batchSize≤5000, timeout≤60s, etc. | `constants/defaults.ts` → `SAFETY_CEILINGS` |
| **Safety floors** | flushInterval≥100ms, timeout≥250ms, configTtl≥30s | `constants/defaults.ts` → `SAFETY_FLOORS` |
| **Config fetch timeout** | 3000ms | `constants/defaults.ts` → `CONFIG_FETCH_TIMEOUT_MS` |
| **Init retry attempts** | 5 | `core/init.ts` → `INIT_MAX_ATTEMPTS` |
| **Event type → route mapping** | Fixed (error→errors, span→spans, etc.) | `route-registry.ts` → `EVENT_TYPE_TO_ROUTE` |
| **Route endpoint paths** | Fixed (/v1/errors, /v1/traces, etc.) | `route-registry.ts` → `ROUTE_ENDPOINTS` |
| **Max spans per trace** | SDK internal default (from TRACING_DEFAULTS) | `constants/internal-defaults.ts` |
| **Max trace duration** | SDK internal default | `constants/internal-defaults.ts` |
| **Error stack trace limit** | SDK internal default | `constants/internal-defaults.ts` |
| **Logging max log size** | SDK internal default | `constants/internal-defaults.ts` |
| **Profiling max duration** | SDK internal default | `constants/internal-defaults.ts` |
| **Console interception** | SDK internal default | `constants/internal-defaults.ts` |

---

## 9. Custom Features — Remote Control Status

| Custom API | Remotely Controllable? | How? |
|---|---|---|
| `captureError()` (manual) | ❌ **NO** — always works | Core API, never gated |
| `captureMessage()` | ❌ **NO** — always works | Core API, never gated |
| `captureLog()` | ✅ Yes | `entitlements.logging` + `features.logging` + `killswitches.disableLogs` |
| `captureReplay()` | ✅ Yes | `entitlements.sessionReplay` + `features.sessionReplay` |
| `captureCronCheckIn()` | ✅ Yes | `entitlements.crons` + `features.crons` |
| `startProfile()` / `stopProfile()` | ✅ Yes | `entitlements.profiling` + `features.profiling` + `killswitches.disableProfiling` |
| `startSpan()` / `withSpan()` / `withSpanSync()` | ✅ Yes | `entitlements.customSpans` + `features.tracing` + `killswitches.disableTracing` |
| `incrementCounter()` / `setGauge()` / `recordHistogram()` | ✅ Yes | `entitlements.customMetrics` + `features.metrics` + `killswitches.disableMetrics` |
| `addUpDownCounter()` | ✅ Yes | Same as above |
| `captureMetric()` | ✅ Yes | Same as above |
| `captureEvent()` | ⚠️ Partial | Feature gate depends on the event's `type` field |
| `monitorMiddleware()` | ✅ Yes | `features.requestCapture` + `entitlements.requestCapture` |
| Auto HTTP/Express instrumentation | ✅ Yes | `features.tracing` + `instrumentation.http/express` |
| Auto MongoDB/Axios instrumentation | ✅ Yes | `features.tracing` + `instrumentation.mongodb/axios` |
| `setUser()` / `setTag()` / scope | ❌ **NO** — always works | Core API |
| `addBreadcrumb()` | ❌ **NO** — always works | Core API |
| `flush()` / `shutdown()` | ❌ **NO** — always works | Core API |
| `getSDKHealth()` / `getConfig()` | ❌ **NO** — always works | Core API |
| `setDebugMode()` / `setLogLevel()` | ❌ **NO** — always works | Core API |

---

## 10. Three-Layer Gate Model (Per Event)

Every event passes through up to THREE independent gates:

```
captureLog('info', 'hello')
    │
    ├─ Gate 1: ENTITLEMENT — entitlements.logging === false? → silent no-op (never reaches pipeline)
    │
    ├─ Gate 2: FEATURE — features.logging === false? → event rejected in pipeline
    │
    ├─ Gate 3: KILLSWITCH — killswitches.disableLogs === true? → event rejected in pipeline
    │
    ├─ Gate 4: SAMPLING — sampling.* rate check (if applicable)
    │
    └─ Gate 5: LIMITS/PRESSURE — rate limit, memory, load shedding
```

| Gate | Layer | Checked at | Effect |
|---|---|---|---|
| Entitlement | Billing | In the capture function itself (before pipeline) | Silent no-op, no event created |
| Feature | Operational | In pipeline `isFeatureEnabled()` | Event rejected with reason |
| Killswitch | Emergency | In pipeline `isFeatureEnabled()` | Event rejected with reason |
| Sampling | Statistical | OTel sampler (spans) or pipeline (requests) | Event dropped deterministically |
| Limits | Resource | Pipeline admission gates | Event rejected: rate_limited, memory, load_shed |

---

## 11. Remote Config Response — Complete Expected Shape

Your backend at `POST /v1/sdk-config` must return this:

```json
{
  "schemaVersion": 1,
  "sdk": {
    "projectId": "your-project-id",
    "environment": "production"
  },
  "features": {
    "tracing": true,
    "requestCapture": true,
    "errors": true,
    "metrics": true,
    "logging": true,
    "profiling": true,
    "crons": true,
    "sessionReplay": true,
    "runtimeMetrics": true,
    "eventLoopMonitoring": true,
    "gcMonitoring": true
  },
  "sampling": {
    "traces": 1.0,
    "requests": 1.0,
    "errors": 1.0,
    "profiles": 1.0,
    "replays": 1.0,
    "metrics": 1.0,
    "routes": {
      "/health": { "traces": 0, "requests": 0, "errors": 0 }
    }
  },
  "instrumentation": {
    "http": true,
    "https": true,
    "fetch": true,
    "axios": true,
    "fastify": false,
    "express": true,
    "graphql": false,
    "prisma": false,
    "mongodb": true,
    "redis": false,
    "bullmq": false
  },
  "privacy": {
    "capture": { "headers": true, "body": true, "response": false, "query": true, "cookies": false },
    "scrubbing": { "enabled": true, "headers": ["authorization", "cookie"], "fields": ["password", "token", "secret"] },
    "piiDetection": { "enabled": true, "maskEmails": true, "maskPhones": true, "maskIPs": true }
  },
  "limits": {
    "maxSpansPerTrace": 500,
    "maxSpanAttributes": 100,
    "maxAttributeLength": 2048,
    "maxPayloadSize": 262144,
    "maxQueueSize": 10000,
    "maxMemoryMb": 256,
    "maxCpuOverheadPercent": 5
  },
  "killswitches": {
    "disableSDK": false,
    "disableTracing": false,
    "disableMetrics": false,
    "disableTransport": false,
    "disableProfiling": false,
    "disableErrors": false,
    "disableLogs": false
  },
  "transport": {
    "retry": { "enabled": true, "maxRetries": 3, "backoff": "exponential", "baseDelayMs": 500 },
    "queue": { "overflowStrategy": "drop_oldest", "maxSize": 10000, "criticalReserve": 100 },
    "keepAlive": true,
    "routes": {
      "traces":   { "url": "http://localhost:5000/api/v1/traces",   "batchSize": 500,  "flushIntervalMs": 5000,  "timeoutMs": 5000,  "compression": "gzip" },
      "requests": { "url": "http://localhost:5000/api/v1/requests", "batchSize": 500,  "flushIntervalMs": 5000,  "timeoutMs": 3000,  "compression": "gzip" },
      "errors":   { "url": "http://localhost:5000/api/v1/errors",   "batchSize": 100,  "flushIntervalMs": 1000,  "timeoutMs": 3000,  "compression": "gzip" },
      "metrics":  { "url": "http://localhost:5000/api/v1/metrics",  "batchSize": 1000, "flushIntervalMs": 10000, "timeoutMs": 5000,  "compression": "gzip" },
      "logs":     { "url": "http://localhost:5000/api/v1/logs",     "batchSize": 200,  "flushIntervalMs": 10000, "timeoutMs": 5000,  "compression": "gzip" },
      "profiles": { "url": "http://localhost:5000/api/v1/profiles", "batchSize": 5,    "flushIntervalMs": 30000, "timeoutMs": 15000, "compression": "gzip" },
      "events":   { "url": "http://localhost:5000/api/v1/events",   "batchSize": 50,   "flushIntervalMs": 5000,  "timeoutMs": 5000,  "compression": "gzip" },
      "crons":    { "url": "http://localhost:5000/api/v1/checkins", "batchSize": 1,    "flushIntervalMs": 0,     "timeoutMs": 5000,  "compression": "none" },
      "replays":  { "url": "http://localhost:5000/api/v1/replays",  "batchSize": 5,    "flushIntervalMs": 10000, "timeoutMs": 30000, "compression": "gzip" }
    }
  },
  "runtime": {
    "configTtlSeconds": 300,
    "staleWhileRevalidate": true
  },
  "meta": {
    "generatedAt": "2026-07-29T00:00:00Z",
    "generatedBy": "control-plane"
  },
  "entitlements": {
    "customSpans": true,
    "customMetrics": true,
    "profiling": true,
    "logging": true,
    "sessionReplay": true,
    "crons": true,
    "requestCapture": true,
    "tracing": true,
    "errors": true,
    "metrics": true
  }
}
```

---

## 12. Recommendations — Making EVERYTHING Remote-Controlled

Currently NOT remote-controlled but SHOULD be:

| Gap | Fix |
|---|---|
| Queue max sizes per route | Add `transport.routes.*.maxQueueSize` to remote config schema |
| Min batch sizes per route | Add `transport.routes.*.minBatchSize` to remote config schema |
| Connection limits per route | Add `transport.connections.maxConnectionsPerRoute.*` (schema exists but unused) |
| Pipeline concurrency cap | Add `limits.maxPendingPipelines` to remote config |
| Plugin/beforeSend timeouts | Add `limits.pluginTimeoutMs` and `limits.beforeSendTimeoutMs` |
| Error dedup window | Add `limits.errorDedupWindowMs` to remote config |
| Max breadcrumbs | Already in init options; add to remote config `limits.maxBreadcrumbs` |
| `captureError()` manual | Add `entitlements.manualErrors` gate (currently ungated) |
| `captureMessage()` | Add `entitlements.messages` gate (currently ungated) |
| Scope APIs | These should remain ungated (they're local state, no network cost) |

**Priority additions for full remote control:**
1. `entitlements.manualErrors` — gate `captureError()` so backend can silence manual error capture
2. `entitlements.messages` — gate `captureMessage()` 
3. `transport.routes.*.maxQueueSize` — per-route queue cap from backend
4. `limits.maxPendingPipelines` — pipeline concurrency from backend
5. `limits.errorDedupWindowMs` — dedup window from backend
