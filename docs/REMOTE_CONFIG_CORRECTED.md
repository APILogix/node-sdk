# SDK Remote Config — Corrected & Complete

## Problems in Your Current Response

Your `/v1/init` response has these issues that will cause SDK validation failures:

| # | Issue | Current | Required |
|---|---|---|---|
| 1 | **Missing `spans` route** | Not present | Required — SDK validates ALL 10 routes |
| 2 | **`sampling.routeOverrides` is wrong key** | `"routeOverrides": []` | Must be `"routes": {}` (object, not array) |
| 3 | **`privacy.pii` wrong key** | `"pii": { ... }` | Must be `"piiDetection": { maskEmails, maskPhones, maskIPs }` |
| 4 | **`privacy.scrubbing.enabled` missing** | Not present | Required boolean |
| 5 | **`privacy.piiDetection.maskIPs` missing** | Has `maskCreditCards`, `maskPhoneNumbers` | SDK expects `maskEmails`, `maskPhones`, `maskIPs` |
| 6 | **`transport.retry.enabled` missing** | Not present | Required boolean |
| 7 | **`transport.retry.backoff` missing** | Not present | Required: `"exponential"` or `"linear"` or `"fixed"` |
| 8 | **`transport.connections` wrong shape** | `{ "total": 50 }` | SDK expects `{ "maxTotalConnections": 50, "acquireTimeoutMs": 5000 }` |
| 9 | **`entitlements` section missing** | Not present | Required for custom API gating |
| 10 | **`instrumentation` wrong format** | `{ "http": { "enabled": true } }` | SDK expects `true/false` OR specific config objects |
| 11 | **`transport.routes.*.priority` is number** | `"priority": 1` | SDK expects string: `"critical"`, `"high"`, `"normal"`, `"low"` |

---

## Corrected Complete Response from `/v1/init`

This is the EXACT shape your backend should return. Every field is validated by the SDK.

```json
{
  "success": true,
  "projectId": "16bffc54-7575-4664-9da7-542bd8b73d82",
  "organizationId": "888e933d-087d-4890-9154-0bca0b9da6c3",
  "environmentId": "6a190e10-8f49-4ed3-9a19-69bda5a5243c",
  "environment": "production",
  "configRevision": 1,
  "configHash": "344f8b9a1c5b3e29906d776ab71293024f9709973552f6a37ee4178af47aa6ed",
  "config": {
    "ingestUrl": "https://ingest.pulse.local/api/v1/events",
    "samplingRate": 1,
    "enableErrors": true,
    "enablePerformance": true,
    "maxRetries": 3,
    "maxPayloadBytes": 1048576,
    "maxQueueSize": 20000,
    "batchSize": 50,
    "flushIntervalMs": 5000
  },
  "plan": "free",
  "ingestion": {
    "endpoint": "https://ingest.pulse.local/api/v1/events",
    "batchSize": 50,
    "flushInterval": 5000,
    "maxQueueSize": 20000
  }
}
```

---

## Corrected Complete Response from `/v1/sdk-config`

This is what `POST /v1/sdk-config` must return. The SDK validates this with `config-validator.ts`:

```json

{
  "schemaVersion": 1,

  "sdk": {
    "projectId": "16bffc54-7575-4664-9da7-542bd8b73d82",
    "environment": "production",
    "release": "1.0.0"
  },

  "features": {
    "tracing": true,
    "requestCapture": true,
    "errors": true,
    "metrics": true,
    "logging": true,
    "profiling": false,
    "crons": false,
    "sessionReplay": false,
    "runtimeMetrics": false,
    "eventLoopMonitoring": false,
    "gcMonitoring": false
  },

  "sampling": {
    "traces": 1.0,
    "requests": 1.0,
    "errors": 1.0,
    "profiles": 0.1,
    "replays": 0.1,
    "metrics": 1.0,
    "routes": {
      "/health": { "traces": 0, "requests": 0, "errors": 0, "metrics": 0 },
      "/favicon.ico": { "traces": 0, "requests": 0 }
    }
  },

  "instrumentation": {
    "http": true,
    "https": true,
    "fetch": true,
    "axios": false,
    "fastify": true,
    "express": true,
    "graphql": false,
    "prisma": false,
    "mongodb": false,
    "redis": false,
    "bullmq": false
  },

  "privacy": {
    "capture": {
      "headers": false,
      "body": false,
      "response": false,
      "query": false,
      "cookies": false
    },
    "scrubbing": {
      "enabled": true,
      "headers": [
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "x-api-key"
      ],
      "fields": [
        "password",
        "secret",
        "token",
        "apiKey",
        "authorization",
        "creditCard",
        "ssn",
        "access_token",
        "refresh_token",
        "client_secret"
      ]
    },
    "piiDetection": {
      "enabled": true,
      "maskEmails": true,
      "maskPhones": true,
      "maskIPs": true
    }
  },

  "limits": {
    "maxSpansPerTrace": 2000,
    "maxSpanAttributes": 128,
    "maxAttributeLength": 4096,
    "maxPayloadSize": 1048576,
    "maxQueueSize": 10000,
    "maxMemoryMb": 256,
    "maxCpuOverheadPercent": 5,
    "tenantGovernance": {
      "enabled": false,
      "maxTenantsTracked": 1000,
      "quotaPerWindow": 10000,
      "windowDurationMs": 60000,
      "criticalReserve": 100
    }
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
    "retry": {
      "enabled": true,
      "maxRetries": 3,
      "backoff": "exponential",
      "baseDelayMs": 500
    },
    "queue": {
      "overflowStrategy": "drop_oldest",
      "maxSize": 10000,
      "criticalReserve": 1000
    },
    "connections": {
      "maxTotalConnections": 50,
      "acquireTimeoutMs": 5000
    },
    "keepAlive": true,
    "routes": {
      "errors": {
        "url": "https://ingest.pulse.local/api/v1/errors",
        "batchSize": 100,
        "flushIntervalMs": 1000,
        "timeoutMs": 5000,
        "compression": "gzip",
        "priority": "critical"
      },
      "events": {
        "url": "https://ingest.pulse.local/api/v1/events",
        "batchSize": 100,
        "flushIntervalMs": 2000,
        "timeoutMs": 5000,
        "compression": "gzip",
        "priority": "high"
      },
      "traces": {
        "url": "https://ingest.pulse.local/api/v1/traces",
        "batchSize": 500,
        "flushIntervalMs": 5000,
        "timeoutMs": 5000,
        "compression": "gzip",
        "priority": "high"
      },
      "spans": {
        "url": "https://ingest.pulse.local/api/v1/spans",
        "batchSize": 500,
        "flushIntervalMs": 5000,
        "timeoutMs": 5000,
        "compression": "gzip",
        "priority": "normal"
      },
      "requests": {
        "url": "https://ingest.pulse.local/api/v1/requests",
        "batchSize": 500,
        "flushIntervalMs": 5000,
        "timeoutMs": 5000,
        "compression": "gzip",
        "priority": "high"
      },
      "metrics": {
        "url": "https://ingest.pulse.local/api/v1/metrics",
        "batchSize": 1000,
        "flushIntervalMs": 10000,
        "timeoutMs": 5000,
        "compression": "gzip",
        "priority": "normal"
      },
      "logs": {
        "url": "https://ingest.pulse.local/api/v1/logs",
        "batchSize": 200,
        "flushIntervalMs": 10000,
        "timeoutMs": 5000,
        "compression": "gzip",
        "priority": "normal"
      },
      "profiles": {
        "url": "https://ingest.pulse.local/api/v1/profiles",
        "batchSize": 5,
        "flushIntervalMs": 30000,
        "timeoutMs": 15000,
        "compression": "gzip",
        "priority": "low"
      },
      "crons": {
        "url": "https://ingest.pulse.local/api/v1/checkins",
        "batchSize": 1,
        "flushIntervalMs": 0,
        "timeoutMs": 5000,
        "compression": "none",
        "priority": "high"
      },
      "replays": {
        "url": "https://ingest.pulse.local/api/v1/replays",
        "batchSize": 5,
        "flushIntervalMs": 10000,
        "timeoutMs": 30000,
        "compression": "gzip",
        "priority": "low"
      }
    }
  },

  "runtime": {
    "configTtlSeconds": 300,
    "staleWhileRevalidate": true
  },

  "meta": {
    "generatedAt": "2026-07-29T17:12:01.313Z",
    "generatedBy": "pulse-config-compiler@1",
    "configHash": "344f8b9a1c5b3e29906d776ab71293024f9709973552f6a37ee4178af47aa6ed"
  },

  "entitlements": {
    "customSpans": true,
    "customMetrics": true,
    "profiling": false,
    "logging": true,
    "sessionReplay": false,
    "crons": false,
    "requestCapture": true,
    "tracing": true,
    "errors": true,
    "metrics": true
  }
}
```


---

## Field-by-Field Explanation — What Each Controls

### `features.*` — Subsystem on/off

| Field | When `false` |
|---|---|
| `tracing` | OTel tracer NOT started. `span` and `trace` events rejected. Auto-instrumentation disabled. |
| `requestCapture` | `monitorMiddleware()` skips capture. `request` events rejected. |
| `errors` | Global `uncaughtException`/`unhandledRejection` handlers NOT installed. `error` events rejected. |
| `metrics` | OTel meter NOT started. `metric` events rejected. Runtime metrics off. |
| `logging` | Logging subsystem NOT started. `log` events rejected. Console interception off. |
| `profiling` | Profiling subsystem NOT started. `profile` events rejected. `startProfile()` returns false. |
| `crons` | Cron subsystem NOT started. `cron_checkin` events rejected. Timeout tracking off. |
| `sessionReplay` | Session manager NOT started. `replay` events rejected. |
| `runtimeMetrics` | Adaptive memory/heap monitoring signals disabled. |
| `eventLoopMonitoring` | Event-loop lag signal disabled. |
| `gcMonitoring` | GC pressure signal disabled. |

### `entitlements.*` — Custom API billing gates

| Field | When `false` — which API becomes no-op |
|---|---|
| `customSpans` | `startSpan()` → noop span, `withSpan()` → noop span, `withSpanSync()` → noop span |
| `customMetrics` | `incrementCounter()`, `setGauge()`, `recordHistogram()`, `addUpDownCounter()` → dropped |
| `profiling` | `startProfile()` → returns false immediately |
| `logging` | `captureLog()` → dropped |
| `sessionReplay` | `captureReplay()` → dropped |
| `crons` | `captureCronCheckIn()` → dropped |
| `requestCapture` | Auto request capture → skipped |
| `tracing` | Auto distributed tracing → skipped |
| `errors` | Auto error capture → skipped |
| `metrics` | Auto runtime metrics → skipped |

### `sampling.*` — What gets sampled

| Field | Range | What it affects |
|---|---|---|
| `traces` | 0.0 - 1.0 | % of traces captured (by traceId hash) |
| `requests` | 0.0 - 1.0 | % of HTTP request events captured |
| `errors` | 0.0 - 1.0 | % of error events captured (usually keep at 1.0!) |
| `profiles` | 0.0 - 1.0 | % of CPU profiles captured |
| `replays` | 0.0 - 1.0 | % of replay sessions captured |
| `metrics` | 0.0 - 1.0 | % of metric events captured |
| `routes` | object | Per-URL-prefix overrides (e.g., silence /health completely) |

### `transport.routes.*` — Per-route delivery tuning

| Field | What it controls |
|---|---|
| `url` | Where events of this type are POSTed |
| `batchSize` | Max events per HTTP request |
| `flushIntervalMs` | Max time to wait before sending a partial batch |
| `timeoutMs` | HTTP timeout per send |
| `compression` | `"gzip"` or `"none"` |
| `priority` | `"critical"` / `"high"` / `"normal"` / `"low"` — affects queue eviction order |

### `killswitches.*` — Emergency controls

All are `boolean`. When `true`:
- `disableSDK` → ALL telemetry stops. Nuclear option.
- `disableTransport` → Events queue locally but never ship. Good for "stop sending, keep collecting".
- Others → specific subsystem silenced immediately.

---

## Performance Tuning Recommendations

| Route | Batch Size | Flush Interval | Why |
|---|---|---|---|
| `errors` | 100 | **1000ms** | Errors should arrive fast (near-real-time alerting) |
| `events` | 100 | 2000ms | Messages are important but not urgent |
| `traces` | 500 | 5000ms | Traces are large; batching reduces HTTP overhead |
| `spans` | 500 | 5000ms | Same as traces (spans compose into traces) |
| `requests` | 500 | 5000ms | High-volume; batching is essential |
| `metrics` | 1000 | **10000ms** | Metrics are aggregated anyway; large batches are efficient |
| `logs` | 200 | 10000ms | Logs are high-volume; batch aggressively |
| `profiles` | 5 | **30000ms** | Profiles are huge (100KB+); send rarely |
| `crons` | **1** | **0** | Crons must be immediate (timeout detection depends on it) |
| `replays` | 5 | 10000ms | Replay segments are large; batch moderately |

**Key principle:** Lower `flushIntervalMs` = faster delivery but more HTTP connections. Higher `batchSize` = fewer connections but higher latency.

---

## Diff: Your Original vs Corrected

| Section | Your version | Corrected | Change type |
|---|---|---|---|
| `sampling.routeOverrides` | `[]` (array) | `"routes": {}` (object) | **BREAKING** — wrong type |
| `privacy.pii` | `{ maskCreditCards, maskPhoneNumbers }` | `"piiDetection": { maskEmails, maskPhones, maskIPs }` | **BREAKING** — wrong key names |
| `privacy.scrubbing.enabled` | missing | `true` | **MISSING** required field |
| `transport.routes.spans` | missing entirely | full route config | **MISSING** required route |
| `transport.retry.enabled` | missing | `true` | **MISSING** field |
| `transport.retry.backoff` | missing | `"exponential"` | **MISSING** field |
| `transport.connections` | `{ total: 50 }` | `{ maxTotalConnections: 50, acquireTimeoutMs: 5000 }` | **WRONG** key names |
| `transport.routes.*.priority` | numbers (1-9) | strings ("critical"/"high"/"normal"/"low") | **WRONG** type |
| `entitlements` | missing entirely | full object with 10 booleans | **MISSING** entire section |
| `instrumentation.*` | `{ enabled: true }` objects | `true/false` booleans | **WRONG** shape |
| `limits.tenantGovernance` | missing | full config | Missing optional section |
| `meta.configHash` | missing | present | Missing optional field |

---

## Minimal Fix Checklist for Your Backend

1. ✅ Add `spans` route to `transport.routes`
2. ✅ Rename `sampling.routeOverrides` → `sampling.routes` and make it an object `{}`
3. ✅ Rename `privacy.pii` → `privacy.piiDetection` with fields: `maskEmails`, `maskPhones`, `maskIPs`
4. ✅ Add `privacy.scrubbing.enabled: true`
5. ✅ Add `transport.retry.enabled: true` and `transport.retry.backoff: "exponential"`
6. ✅ Fix `transport.connections` keys: `total` → `maxTotalConnections`
7. ✅ Change `transport.routes.*.priority` from numbers to strings
8. ✅ Add `entitlements` section (10 booleans)
9. ✅ Fix `instrumentation.*` to use `true/false` instead of `{ enabled: true/false }`
10. ✅ Add `limits.tenantGovernance` object (optional but recommended)
