# Pulse SDK — Developer Experience (DX) Audit

An honest assessment of SDK complexity from the perspective of a **solo developer or small team** (1–5 engineers) integrating observability for the first time.

---

## Overall DX Rating

| Category | Score | Verdict |
|----------|-------|---------|
| **Time to First Event** | ⭐⭐⭐⭐ 4/5 | 4 lines to init + capture — solid |
| **Learning Curve** | ⭐⭐⭐ 3/5 | Too many exports; overwhelming for beginners |
| **API Surface Size** | ⭐⭐ 2/5 | 40+ exports — way too large for a small SDK |
| **Configuration Complexity** | ⭐⭐⭐ 3/5 | Works with just `apiKey`, but full config is intimidating |
| **Error Messages** | ⭐⭐⭐⭐⭐ 5/5 | Excellent — Zod validation, SDKError with codes and context |
| **Documentation** | ⭐⭐⭐⭐ 4/5 | Thorough, but could use a quick-start with fewer options |
| **Zero-Config Experience** | ⭐⭐⭐ 3/5 | Needs `apiKey` + server running — no standalone mode |
| **Framework Integration** | ⭐⭐⭐⭐ 4/5 | Express is 1 line; Fastify is clean |
| **TypeScript Support** | ⭐⭐⭐⭐⭐ 5/5 | Perfect — strict types, full IntelliSense |
| **Debugging** | ⭐⭐⭐⭐ 4/5 | `debug: true` gives clear logs, but no dry-run mode |

**Overall: 3.7 / 5** — Enterprise-ready but not beginner-friendly.

---

## Complexity Breakdown — What a Small Dev Actually Faces

### ✅ What's Easy (Gets Right)

**Minimum viable setup is only 4 lines:**
```typescript
import { createSDK, captureError } from '@vikasbaplawat1/pulse-sdk'
await createSDK({ apiKey: 'pk_live_...' })

// Later in code...
captureError(new Error('Something broke'))
```

**Express integration is 1 line:**
```typescript
app.use(monitorMiddleware)
```

**Error messages are excellent:**
```
SDKError: Init config field maxPayloadBytes must be an integer >= 1
  code: INVALID_INIT_CONFIG
  context: { fieldName: "maxPayloadBytes", min: 1, value: 0 }
```

### ⚠️ What's Confusing (Needs Improvement)

#### 1. Too Many Imports — "What do I actually need?"

A small dev sees this in the docs and panics:
```typescript
import {
  createSDK, init, shutdown, flush, getConfig, SDKError,
  captureError, captureRequest, captureMessage, captureEvent, captureMetric,
  incrementCounter, setGauge, recordHistogram,
  addBreadcrumb, getRequestContext, getTraceId, getSpanId,
  startSpan, withSpan, withSpanSync, getActiveSpan, flushTracer,
  extractTraceContext, injectTraceContext, parseTraceparent, createTraceparent,
  PulseSpan, getSessionManager, monitorMiddleware, instrumentHttpClient,
  setLogger, getLogger, setDebugMode, Severity, severityFromString,
  // ... plus 15 type exports
} from '@vikasbaplawat1/pulse-sdk'
```

**Problem**: 40+ exports. Sentry has ~8 that 95% of users need.

#### 2. `createSDK` vs `init` — Why Both?

```typescript
// These do the same thing — which one should I use?
await createSDK({ apiKey: '...' })
await init({ apiKey: '...' })
```

**Problem**: Two entry points = confusion. Pick one.

#### 3. Server Dependency at Init

```typescript
await createSDK({ apiKey: '...' })
// ↑ This makes an HTTP call to /v1/init
// If your server is down, SDK retries 5 times then silently fails
```

**Problem**: A dev running locally without the Pulse backend gets zero feedback. The SDK swallows the failure. They write `captureError(err)` and nothing happens — no console warning, no indication why.

#### 4. Tracing Requires OTel Knowledge

```typescript
const span = startSpan('db.query', {
  attributes: { 'db.system': 'postgresql' }  // ← OTel semantic conventions
})
```

**Problem**: A small dev doesn't know OTel attribute naming conventions. They'd write `{ database: 'postgres' }` which works but produces non-standard telemetry.

#### 5. `captureRequest` Has a Complex Shape

```typescript
captureRequest({
  type: 'request',       // ← why do I need to specify this?
  requestId: '...',      // ← I have to generate my own ID?
  url: '/api/users',
  method: 'GET',
  statusCode: 200,
  latency: 142,
  timestamp: Date.now(), // ← manual timestamp?
})
```

**Problem**: Too many required fields. The middleware handles this automatically, but if a dev tries to use it manually, it's painful.

#### 6. No "Just Works" Mode for Common Stacks

Sentry: `Sentry.init({ dsn: '...' })` — automatically captures errors, traces, and breadcrumbs with zero config.

Pulse: You need to manually wire `monitorMiddleware`, `instrumentHttpClient()`, `setupGlobalErrorHandlers()` (which is internal), etc.

---

## Comparison with Competitor DX

| Feature | Sentry | Datadog | **Pulse SDK** |
|---------|--------|---------|---------------|
| Lines to first error | 2 | 3 | 4 |
| Auto-instrument Express | ✅ Built-in | ✅ Built-in | ⚠️ Manual `app.use()` |
| Auto-instrument HTTP | ✅ Built-in | ✅ Built-in | ⚠️ Manual `instrumentHttpClient()` |
| Works without backend | ✅ (sends to sentry.io) | ✅ (sends to DD) | ❌ Needs self-hosted server |
| Config options count | ~15 | ~20 | ~25 |
| Public exports count | ~10 | ~12 | ~40+ |
| DSN/key format | URL-based DSN | API key | API key |
| Zero-config tracing | ✅ | ✅ | ❌ Need `enableTracing: true` + manual spans |

---

## Future Changes to Make the SDK Developer-Friendly

### 🔴 Priority 1 — Must Do

#### 1. Create a "Simple Mode" / Auto-Instrument

```typescript
// FUTURE: One import, zero config beyond apiKey
import { createSDK } from '@vikasbaplawat1/pulse-sdk'

await createSDK({
  apiKey: 'pk_live_...',
  integrations: 'auto',  // ← auto-detect Express/Fastify/HTTP and instrument
})
// That's it. Errors, requests, traces, breadcrumbs — all automatic.
```

**Why**: 90% of users want "just make it work." Power users can opt into manual mode.

#### 2. Reduce Public API to Core Essentials

Split exports into tiers:

```typescript
// Tier 1 — what 95% of users need (main import)
import { createSDK, captureError, captureMessage, shutdown } from '@vikasbaplawat1/pulse-sdk'

// Tier 2 — tracing (sub-path import)
import { withSpan, startSpan } from '@vikasbaplawat1/pulse-sdk/tracing'

// Tier 3 — metrics (sub-path import)
import { incrementCounter, setGauge } from '@vikasbaplawat1/pulse-sdk/metrics'

// Tier 4 — advanced/plugin authors (sub-path import)
import { extractTraceContext, PulseSpan } from '@vikasbaplawat1/pulse-sdk/advanced'
```

#### 3. Add Offline / Local-Only Mode

```typescript
await createSDK({
  apiKey: 'pk_dev_local',
  transport: { mode: 'console' },  // ← prints events to console instead of HTTP
})
```

**Why**: Devs need to test locally without running the Pulse backend. Currently the SDK silently swallows failures.

#### 4. Simplify `captureRequest`

```typescript
// FUTURE: Only require what matters
captureRequest('/api/users', 'GET', 200, 142)

// Or auto-capture from res object
captureRequest(req, res)
```

### 🟠 Priority 2 — Should Do

#### 5. Add a CLI for Quick Setup

```bash
npx @vikasbaplawat1/pulse-sdk init
# Interactive prompt:
# > API Key: pk_live_...
# > Framework: Express / Fastify / None
# > Creates instrument.ts with recommended config
```

#### 6. Add Auto-Discovery for Frameworks

```typescript
// SDK detects Express/Fastify at runtime and auto-patches
await createSDK({
  apiKey: '...',
  autoInstrument: {
    http: true,       // patch http/https outbound calls
    express: true,    // auto-find and patch Express app
    database: true,   // auto-patch pg/mysql/mongodb drivers
  },
})
```

#### 7. Add a Dashboard Health Check

```typescript
import { getSDKHealth } from '@vikasbaplawat1/pulse-sdk'

app.get('/internal/pulse-health', (req, res) => {
  res.json(getSDKHealth())
  // {
  //   initialized: true,
  //   circuitState: "CLOSED",
  //   queueDepth: 12,
  //   eventsSent: 4521,
  //   eventsDropped: 3,
  //   sessionHealth: { crashFreeRate: 0.99 },
  //   tracerActive: true,
  //   uptime: 3600000,
  // }
})
```

#### 8. Pretty Console Output in Dev Mode

```
┌─ Pulse SDK ────────────────────────────────────┐
│ ✅ Initialized: payments-service @ production   │
│ ✅ Tracing: enabled (OpenTelemetry)             │
│ ✅ Metrics: enabled                             │
│ ✅ Error tracking: enabled                      │
│ 📡 Ingestion: https://ingest.pulse.dev/v1      │
│ 🔄 Batch: 25 events / 5s flush                 │
└─────────────────────────────────────────────────┘
```

#### 9. Typed Error Codes Enum

```typescript
// FUTURE: Instead of string error codes
import { ErrorCode } from '@vikasbaplawat1/pulse-sdk'

try {
  await createSDK({ apiKey: '' })
} catch (err) {
  if (err.code === ErrorCode.INVALID_API_KEY) {
    // TypeScript autocomplete for all possible error codes
  }
}
```

### 🟡 Priority 3 — Nice to Have

#### 10. Playground / Sandbox Mode

```typescript
await createSDK({
  apiKey: 'pk_sandbox',
  sandbox: true,  // ← events logged to console + stored in memory for inspection
})

// Later...
import { getSandboxEvents } from '@vikasbaplawat1/pulse-sdk/sandbox'
console.log(getSandboxEvents())  // see all captured events without a backend
```

#### 11. Source Map Upload for Stack Traces

```bash
npx pulse-sdk upload-sourcemaps --release 2.0.0 --dir ./dist
```

#### 12. Performance Budgets

```typescript
await createSDK({
  apiKey: '...',
  performance: {
    budgets: {
      'db.query.*': { warn: 100, error: 500 },      // ms
      'http.outbound.*': { warn: 200, error: 1000 }, // ms
    },
  },
})
// SDK auto-captures violations as warning/error events
```

#### 13. React / Frontend SDK

```typescript
// Future: Browser SDK with the same API
import { createSDK, captureError } from '@vikasbaplawat1/pulse-sdk/browser'

createSDK({ apiKey: '...', dsn: 'https://ingest.pulse.dev' })

window.addEventListener('error', (e) => captureError(e.error))
```

#### 14. OpenTelemetry Collector Export

```typescript
await createSDK({
  apiKey: '...',
  exporters: {
    otlp: { endpoint: 'http://otel-collector:4318' },  // send to any OTLP backend
    pulse: { endpoint: 'https://ingest.pulse.dev' },    // also send to Pulse
  },
})
```

---

## Summary — What to Fix First

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 1 | Auto-instrument mode (`integrations: 'auto'`) | 🟢 Huge — removes 80% of setup code | Medium |
| 2 | Sub-path exports to reduce API surface | 🟢 Huge — less overwhelming for new devs | Low |
| 3 | Console/local transport mode | 🟢 High — enables local dev without backend | Low |
| 4 | Simplify `captureRequest` API | 🟡 Medium — fewer required fields | Low |
| 5 | Pretty init banner in dev mode | 🟡 Medium — instant confidence the SDK is working | Low |
| 6 | `getSDKHealth()` endpoint | 🟡 Medium — production observability of the SDK itself | Low |
| 7 | CLI scaffolding tool | 🟡 Medium — faster onboarding | Medium |
| 8 | Auto-discover frameworks | 🟢 High — true zero-config | High |

**Bottom line**: The SDK is enterprise-grade in capability but enterprise-grade in complexity too. A small dev doesn't need circuit breakers, rate limiters, or W3C baggage propagation on day one. They need `createSDK({ apiKey })` to just *work* and capture everything automatically. The #1 improvement is an **auto-instrument mode** that does 90% of the wiring with zero manual setup.
