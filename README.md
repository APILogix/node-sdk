# Pulse SDK for Node.js

`@vikasbaplawat1/pulse-sdk` is an enterprise-grade observability SDK for Node.js. It captures errors, requests, traces, metrics, and logs and ships them to a backend control plane that drives every runtime behaviour via remote config.

The SDK itself is intentionally thin: it captures, applies safety bounds, and ships. Sampling rates, ignored routes, scrubbing rules, and feature toggles all come from the backend.

ESM-first. Use with `import`.

## Requirements

- Node.js 18 or newer
- A Pulse public API key
- A reachable backend that serves `/v1/sdk-config`

## Installation

```bash
npm install @vikasbaplawat1/pulse-sdk
# Optional, depending on which framework you instrument:
npm install express  # for monitorMiddleware()
```

## Quick Start

```js
import express from "express"
import { createSDK, monitorMiddleware, captureError } from "@vikasbaplawat1/pulse-sdk"

await createSDK({
  apiKey: process.env.PULSE_API_KEY,
  service: "payments-service",
  environment: "production",
  release: "1.4.2",
})

const app = express()
app.use(express.json())
app.use(monitorMiddleware())

app.get("/", (req, res) => {
  res.json({ status: "ok" })
})

app.use((err, req, res, next) => {
  captureError(err, { route: req.originalUrl, method: req.method })
  res.status(500).json({ message: err.message })
})

app.listen(3000)
```

## How it works at a glance

1. `createSDK()` (or `init()`) starts the SDK in **safe-defaults mode** — transport off, sampling 0, no features running.
2. The SDK sends `POST /v1/sdk-config` to the backend with its identity (service, environment, runtime, capabilities, schema version) and a 3-second timeout.
3. The backend returns a `RemoteConfigResponse` describing exactly what the SDK should do for this project.
4. The SDK validates the response, clamps every numeric field to safety ceilings, and wires the config into every engine.
5. Background refresh keeps the config live (default every 5 minutes; backend-tunable).
6. Every captured event flows through the pipeline gates (killswitch → feature controller → tenant governor → sampling engine → load shedder → scrubber → limits → transport).

If the backend is unreachable: the SDK keeps running on baked-in defaults, retries every 30 seconds, and never blocks your application.

See `docs/backend-flow.html` for a visual end-to-end walkthrough.

## Public API

### `createSDK(options) / init(options)`

Initializes the SDK. Idempotent — a second call with the same `apiKey` returns the existing config.

```js
await createSDK({
  apiKey: "pk_live_...",
  service: "payments-service",      // optional, defaults to "unknown-service"
  environment: "production",        // optional, defaults to "production"
  release: "1.4.2",                 // optional release identifier
  baseUrl: "https://api.pulse.dev", // override the backend base URL
  configUrl: "...",                 // override only the config endpoint
  sampleRate: 0.5,                  // global sampling override
  maxBreadcrumbs: 200,              // breadcrumb ring buffer cap
  debug: false,                     // verbose internal logging
})
```

Init never throws on backend failure — it logs and returns `undefined` so your app can keep running.

### `monitorMiddleware(options?)` (Express)

Captures request telemetry on every request. Sampling, feature toggles, and ignored routes all come from remote config; the local options here are framework-level overrides.

```js
app.use(monitorMiddleware({
  ignorePaths: ["/healthz", /^\/internal/],   // local override, evaluated first
  ignoreMethods: ["OPTIONS"],
  captureHeaders: true,                       // overrides remote privacy.capture.headers
  captureQuery: true,                         // overrides remote privacy.capture.query
  captureBody: false,                         // overrides remote privacy.capture.body
}))
```

Captured per request:
- URL, method, status code, latency, timestamp
- `requestId`, `traceId`, `spanId`, `tenantId`, `userId`, `sessionId`
- `clientIp`, `userAgent`, `referer`
- Sanitized headers, query, body (gated by `privacy.capture.*`)
- Response content-length

### `fastifyPulsePlugin` (Fastify)

```js
import { fastifyPulsePlugin } from "@vikasbaplawat1/pulse-sdk"

await fastify.register(fastifyPulsePlugin, {
  ignorePaths: ["/healthz"],
})
```

Same options surface as the Express middleware.

### `registerAutoInstrumentations()`

One-call wiring for OpenTelemetry instrumentations (HTTP, Express, Fastify, Undici fetch, GraphQL, Prisma, MongoDB, Redis, BullMQ, Axios).

```js
import { registerAutoInstrumentations } from "@vikasbaplawat1/pulse-sdk"

registerAutoInstrumentations({
  http: true,
  express: true,
  fastify: true,
  prisma: true,
  // ...
})
```

Each toggle is also remote-config driven via `instrumentation.*` — these args are local fallbacks.

### Capture functions

```js
import {
  captureError,
  captureRequest,
  captureMessage,
  captureEvent,
  captureMetric,
  incrementCounter,
  setGauge,
  recordHistogram,
} from "@vikasbaplawat1/pulse-sdk"

captureError(new Error("checkout failed"), {
  route: "/checkout",
  method: "POST",
  feature: "payments",
})

captureMessage("auth.login.success", "info")

incrementCounter("orders.completed", 1, { region: "us-east" })
setGauge("queue.depth", 42)
recordHistogram("checkout.duration_ms", 132)
```

### Scope & breadcrumbs

```js
import {
  setUser,
  setTag,
  setExtra,
  setContext,
  withScope,
  addBreadcrumb,
} from "@vikasbaplawat1/pulse-sdk"

setUser({ id: "user-123", email: "user@example.com" })
setTag("region", "us-east")
addBreadcrumb({ category: "navigation", message: "page loaded" })

withScope(scope => {
  scope.setTag("checkout.step", "shipping")
  captureMessage("step entered")
})
```

### Manual tracing

```js
import { startSpan, withSpan, getActiveSpan } from "@vikasbaplawat1/pulse-sdk"

await withSpan("checkout.submit", async span => {
  span.setAttribute("cart.items", cart.length)
  await processOrder()
})
```

### Lifecycle

```js
import { flush, shutdown } from "@vikasbaplawat1/pulse-sdk"

process.on("SIGTERM", async () => {
  await shutdown(15_000)   // up to 15s for the queue to drain
  process.exit(0)
})
```

## Power-user APIs

Internal engines, processors, and runtime singletons live behind a sub-path:

```js
import { ConfigManager, ConfigState, KillswitchEngine } from "@vikasbaplawat1/pulse-sdk/internals"

const state = ConfigManager.getInstance().getState()
//   "pending" | "safe_defaults" | "live"

if (state !== ConfigState.Live) {
  console.warn("SDK has not yet received remote config")
}
```

The `/internals` surface has **no stability guarantees**. It changes between minor versions. Use only when the public API genuinely doesn't cover your need.

## Configuration

User-facing options on `createSDK()`:

| Field | Type | Default |
|-------|------|---------|
| `apiKey` | string | required |
| `service` | string | `"unknown-service"` |
| `environment` | string | `"production"` |
| `release` | string | undefined |
| `baseUrl` | string | env `SDK_BASE_URL` |
| `configUrl` | string | `${baseUrl}/v1/sdk-config` |
| `sampleRate` | 0..1 | from remote config |
| `maxBreadcrumbs` | int | 100 |
| `enableErrors` / `enableTracing` / `enableMetrics` / `enablePerformance` | bool | from remote config |
| `beforeSend` | fn | undefined |
| `eventProcessors` | fn[] | undefined |
| `plugins` | array | undefined |
| `dataScrubbing` | object | from remote config |
| `transport` | object | from remote config |
| `debug` | bool | false |
| `logLevel` | severity | `"warning"` |
| `shutdownTimeoutMs` | int | 10000 |

For local development or self-hosted backends:

```bash
# macOS / Linux
SDK_BASE_URL="http://localhost:3000/api" node app.js

# Windows PowerShell
$env:SDK_BASE_URL = "http://localhost:3000/api"
node app.js
```

## Health snapshot

Get an operational snapshot at any time:

```js
import { getSDKHealth } from "@vikasbaplawat1/pulse-sdk"

console.log(getSDKHealth())
// {
//   initialized: true,
//   circuitState: "closed,closed,closed",
//   queueSize: 1342,
//   queueDropped: 0,
//   memory: { level: "normal", heapUsedMb: 78.3, heapUtilization: 0.42 },
//   ...
// }
```

## Performance

Latest stress test on 50k mixed events (errors, messages, metrics):

```
captureRate    = 64,103 events/sec
captureMs      = 780 ms
shutdownMs     = 2,052 ms
delivered      = 38,030 events  (3× the v2 number)
peakHeap       = 78.8 MB
```

See `docs/STRESS_TEST_V3.md` for the breakdown and the explanation of the v2 → v3 trade-offs.

## Documentation

- `docs/backend-flow.html` — visual end-to-end backend control flow
- `docs/PHASE_1_CHANGES.md` — detailed schema migration report (Phases 1–4)
- `docs/MIGRATION_V2_TO_V3.md` — step-by-step migration guide
- `docs/STRESS_TEST_V3.md` — current stress test numbers and analysis
- `docs/PERFORMANCE_OPTIMIZATION.md` — historical (v2) performance optimization notes
- `docs/SDK_FEATURES_IMPLEMENTATION.md` — per-feature implementation walkthrough

## Versioning

Semver. v3.x bumps **may not** include schema breaking changes within the same major. The wire-format `schemaVersion` field protects you against upgrade mismatches: if your backend is ahead of the SDK, the SDK refuses the config and falls back to safe defaults.

## License

ISC.
