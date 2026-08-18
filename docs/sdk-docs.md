# Pulse SDK for Node.js — Complete Integration Guide

`@vikasbaplawat1/pulse-sdk` is an ESM observability SDK for Node.js providing error tracking, distributed tracing, metrics, structured logs, request capture, CPU profiling, session replay segments, and cron monitoring. This guide documents every exported API derived directly from the SDK's source code. See `AUDIT_REPORT.md` for the underlying audit and `internal-sdk.md` for internal architecture.

> Everything described here is verified against source. Where a detail could not be verified from the codebase, it is marked **Not Found In Codebase** rather than assumed.

## Table of Contents

1. Installation
2. Quick Start
3. Configuration
4. Auto Features
5. Manual API Reference
6. SDK Lifecycle
7. TypeScript Reference
8. Troubleshooting
9. FAQ
10. Migration Guide
11. Best Practices
12. Performance Recommendations
13. Security

---

## 1. Installation

The package is pure ESM (`"type": "module"` in `package.json`) and requires the global `fetch` API, so **Node.js 18 or newer** is the practical minimum (the runtime does not use a fetch polyfill anywhere in the codebase).

```bash
npm install @vikasbaplawat1/pulse-sdk
```

```bash
pnpm add @vikasbaplawat1/pulse-sdk
```

```bash
yarn add @vikasbaplawat1/pulse-sdk
```

```bash
bun add @vikasbaplawat1/pulse-sdk
```

### TypeScript support

The package ships its own type declarations (`dist/index.d.ts`, `dist/internals.d.ts` per `package.json`'s `exports` map) — no `@types/` package is needed. The SDK is written entirely in TypeScript, so every exported function, class, and interface documented below carries full type information.

### Bundled vs peer dependencies

The package bundles its full OpenTelemetry instrumentation set (HTTP, Express, Fastify, GraphQL, MongoDB, MySQL2, PostgreSQL, Redis, Undici) plus `source-map-js` and `zod` — no extra installs are needed for those. Two integrations are **optional peer dependencies** and must be installed separately if you use them:

```json
"peerDependencies": {
  "@prisma/client": "^7.0.0",
  "bullmq": "^2.0.0 || ^3.0.0 || ^4.0.0 || ^5.0.0"
}
```

Both are marked `optional` in `peerDependenciesMeta`, so installing the SDK without them will not fail — the corresponding instrumentation simply has nothing to patch. Axios is treated similarly: the SDK's Axios instrumentation resolves the `axios` module at runtime via a multi-strategy loader and silently no-ops if it cannot be found.

---

## 2. Quick Start

### Minimal production example

```ts
import { createSDK, captureError } from '@vikasbaplawat1/pulse-sdk'

await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
})

try {
  await runApplicationLogic()
} catch (error) {
  captureError(error)
  throw error
}
```

`createSDK` is exactly equivalent to calling `init` — it exists purely as a more discoverable name. The API key is the only required option; it is **not** read automatically from an environment variable — reading `process.env.PULSE_API_KEY` above is application convention, not SDK behavior.

### Express

```ts
import express from 'express'
import { createSDK, monitorMiddleware, captureError } from '@vikasbaplawat1/pulse-sdk'

await createSDK({ apiKey: process.env.PULSE_API_KEY! })

const app = express()
app.use(express.json()) // parse JSON bodies before the SDK middleware if you want body capture
app.use(monitorMiddleware({
  ignorePaths: ['/health', /^\/internal\//],
  ignoreMethods: ['OPTIONS'],
}))

app.get('/orders/:id', async (req, res) => {
  res.json({ id: req.params.id })
})

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  captureError(err, { mechanism: 'express.error-handler' })
  res.status(500).json({ error: 'internal_error' })
})

app.listen(3000)
```

Initialize the SDK **before** requiring/importing anything you want auto-instrumented — libraries already loaded when `registerAutoInstrumentations()` runs may not be patchable by their OpenTelemetry instrumentation package.

### Fastify

```ts
import Fastify from 'fastify'
import { createSDK, fastifyPulsePlugin } from '@vikasbaplawat1/pulse-sdk'

await createSDK({ apiKey: process.env.PULSE_API_KEY! })

const fastify = Fastify()
await fastify.register(fastifyPulsePlugin, {
  ignorePaths: ['/health'],
})

fastify.get('/orders/:id', async (request) => {
  return { id: (request.params as { id: string }).id }
})

await fastify.listen({ port: 3000 })
```

### Plain Node (no framework)

```ts
import { createServer } from 'node:http'
import { createSDK, captureError, captureRequest, getTraceId, getSpanId } from '@vikasbaplawat1/pulse-sdk'

await createSDK({ apiKey: process.env.PULSE_API_KEY! })

const server = createServer((req, res) => {
  const startedAt = Date.now()
  res.on('finish', () => {
    captureRequest({
      type: 'request',
      requestId: crypto.randomUUID(),
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      statusCode: res.statusCode,
      latency: Date.now() - startedAt,
      timestamp: startedAt,
      traceId: getTraceId(),
      spanId: getSpanId(),
    })
  })
  res.end('ok')
})

process.on('unhandledRejection', (reason) => captureError(reason))
server.listen(3000)
```

### Serverless

```ts
import { createSDK, captureError, flush } from '@vikasbaplawat1/pulse-sdk'

let initialized: Promise<unknown> | null = null

export async function handler(event: unknown): Promise<{ statusCode: number }> {
  initialized ??= createSDK({ apiKey: process.env.PULSE_API_KEY! })
  await initialized

  try {
    await processEvent(event)
    return { statusCode: 200 }
  } catch (error) {
    captureError(error)
    return { statusCode: 500 }
  } finally {
    // Serverless runtimes may freeze/terminate the process between
    // invocations without running normal shutdown hooks — flush explicitly
    // so batched telemetry isn't stranded in memory.
    await flush()
  }
}
```

`init()`/`createSDK()` is idempotent for the same API key (calls sharing an in-flight promise, or returning the existing config once initialized) — the `initialized ??=` guard above prevents re-initializing on every warm invocation.

### Worker (background job process)

```ts
import { createSDK, captureError, withSpan, shutdown } from '@vikasbaplawat1/pulse-sdk'

await createSDK({ apiKey: process.env.PULSE_API_KEY!, applicationName: 'billing-worker' })

async function processJob(jobId: string): Promise<void> {
  await withSpan('job.process', async (span) => {
    span.setAttribute('job.id', jobId)
    await doWork(jobId)
  })
}

process.on('SIGTERM', async () => {
  await shutdown(10_000)
  process.exit(0)
})
```

SIGTERM/SIGINT handlers registered by the SDK itself already call `shutdown()`, but a worker process that needs to control its own exit code (as above) should register its own handler and call `shutdown()` explicitly rather than relying solely on the SDK's default handling.

---

## 3. Configuration

### 3.1 `SDKInitOptions` — every field

| Name | Type | Default | Required | Description |
|---|---|---|---|---|
| `apiKey` | `string` | — | **Yes** | Non-empty credential. The only field sent to the control plane. Rejected if empty or contains control characters. |
| `baseUrl` | `string` | production SaaS origin | No | Overrides the control-plane origin. Must be a bare HTTP(S) origin — no path, query, or credentials. Also overridable via the `SDK_BASE_URL` environment variable (explicit option takes precedence). |
| `applicationName` | `string` | discovered from `package.json`, else `'unknown-application'` | No | Overrides the consuming application's name in event metadata. |
| `applicationVersion` | `string` | discovered from `package.json`, else `'0.0.0-unknown'` | No | Overrides the consuming application's version in event metadata. |
| `packageJsonPath` | `string` | auto-discovered | No | Explicit path to `package.json` for metadata discovery. Relative paths resolve from `process.cwd()`. |
| `maxBreadcrumbs` | `number` | `100` | No | Local breadcrumb ring-buffer capacity. Validated range `0`-`1000`. |
| `plugins` | `SDKPlugin[]` | `[]` | No | Application extension hooks (see §5.10). |
| `eventProcessors` | `EventProcessor[]` | `[]` | No | Functions run on every event before `beforeSend`. |
| `beforeBreadcrumb` | `(breadcrumb, hint?) => Breadcrumb \| null` | — | No | Filter/transform breadcrumbs before they enter the ring buffer. |
| `beforeSend` | `(event) => event \| null \| Promise<...>` | — | No | Final user-controlled filter before transport. |
| `debug` | `boolean` | `false` | No | Enables the SDK's internal debug-level logging. |
| `logLevel` | `'debug' \| 'info' \| 'warning' \| 'error' \| 'fatal'` | `'warning'` (or `'debug'` if `debug: true`) | No | Minimum level for the SDK's own internal logs (not application telemetry). |
| `shutdownTimeoutMs` | `number` | `10000` | No | Maximum time `shutdown()` waits for graceful drain. Validated range `1000`-`60000`. |
| `sourceMaps` | `{ paths?, allowRemote?, embedSourceContent? }` | all disabled/empty | No | Source-map resolution controls (see §12). |

The options object is validated by a strict Zod schema — **unknown keys are rejected**, not silently ignored. Passing an invalid value throws `SDKError('INVALID_INIT_OPTIONS')` synchronously, before any network activity.

### 3.2 What is *not* a local option

Every behavior-affecting setting beyond the table above — features, sampling rates, entitlements, transport routing/retry/queue behavior, privacy/scrubbing rules, and killswitches — comes exclusively from the backend's response to the one initialization request. There is no local override mechanism for any of these; `SDKInitOptions` intentionally does not contain fields for them.

### 3.3 Common mistakes

- Passing an unrecognized key (e.g., a typo like `apikey` instead of `apiKey`) — the strict schema rejects the entire options object rather than ignoring the typo.
- Setting `baseUrl` to a URL with a path or query string — only a bare origin is accepted.
- Assuming `debug: true` also raises the *application* telemetry verbosity — it only affects the SDK's own internal diagnostic logging, not what gets captured or sent.
- Calling `createSDK()` a second time with a *different* `apiKey` while already initialized — this throws `SDKError('SDK_ALREADY_INITIALIZED')` rather than reinitializing; call `shutdown()` first if you need to switch identities.

---

## 4. Auto Features

These operate automatically once enabled by the active remote configuration — do not manually call the corresponding capture functions for the same signal, or you may produce duplicate events.

### 4.1 Automatic HTTP/HTTPS tracing

- **Purpose**: create spans for outgoing HTTP(S) requests and OTel-recognized incoming requests.
- **Trigger**: any `http.request`/`https.request` call, once `instrumentation.http`/`https` is enabled remotely and the `tracing` entitlement is active.
- **Captured data**: method, URL, status code, timing, and (subject to privacy settings) headers/query/body attributes.
- **Disable**: set `instrumentation.http`/`https` to `false` remotely, or activate the `disableTracing`/`disableSDK` killswitch.
- **Performance impact**: not independently benchmarked in this repository — **Not Found In Codebase**.
- **Limitations**: a known upstream race condition in the underlying OTel instrumentation (socket destroyed before a response is fully formed) is defended against with a heuristic classifier, but is not eliminated at the source.

### 4.2 Express / Fastify request capture

- **Purpose**: emit a discrete `request` event per handled HTTP request, correlated with the OTel-created server span.
- **Trigger**: every request that reaches `monitorMiddleware()` / `fastifyPulsePlugin`, subject to the capture gate (killswitches, entitlements, feature flags, and route-based sampling).
- **Captured data**: method, normalized route, status code, latency, trace/span IDs, optionally user/tenant/session IDs, client IP (hashed by default), and (subject to remote privacy settings) headers/query/body.
- **Disable**: pass `ignorePaths`/`ignoreMethods` locally, or disable `features.requestCapture`/`features.tracing` remotely.
- **Performance impact**: cheap local-ignore-path checks run before any SDK engine is touched, specifically to keep overhead near-zero for misconfigured ignore lists.
- **Example**: see §2's Express/Fastify quick-start snippets.
- **Limitations**: the middleware never creates a fallback span itself — if OTel's HTTP instrumentation is disabled, request events are still emitted but without span correlation.

### 4.3 Database/cache/queue instrumentation (MongoDB, Redis, PostgreSQL, MySQL2, Prisma, BullMQ)

- **Purpose**: create spans for database queries, cache commands, and job-queue operations.
- **Trigger**: the corresponding client library call, once its `instrumentation.*` flag is enabled remotely.
- **Captured data**: operation name, target (collection/table/queue), timing; raw query/parameter capture is off by default and gated by remote privacy settings.
- **Disable**: per-integration remote flag, or the global tracing killswitch.
- **Performance impact**: **Not Found In Codebase**.
- **Limitations**: Redis always redacts a hardcoded list of sensitive commands (`AUTH`, `CONFIG SET/GET`, `DEL`, `EXPIRE(AT)`, `GET`, `SET`, `HSET`, `HGET`, `HGETALL`) regardless of capture settings. Prisma's `captureParams` option has no underlying library hook — parameter redaction, where it happens, is enforced only by generic downstream scrubbing.

### 4.4 Automatic error capture

- **Purpose**: capture uncaught exceptions, unhandled promise rejections, and (optionally) `console.error` calls without any explicit `captureError()` call.
- **Trigger**: process-level `uncaughtException`/`unhandledRejection` events, or `console.error(...)` invocations.
- **Captured data**: full `ErrorEvent` shape with `mechanism` set to `'uncaughtException'`, `'unhandledRejection'`, or `'console.error'`.
- **Disable**: the `disableErrors` killswitch, or the `errors` entitlement being revoked.
- **Performance impact**: negligible — these are process-level listeners, not per-request work.
- **Limitations**: installing an `uncaughtException` listener suppresses Node's default fatal-exit behavior; the SDK compensates by setting `process.exitCode = 1` so the process still exits non-zero, then races a bounded (2-second default) flush against process termination.

### 4.5 Automatic runtime/CPU/GC metrics

- **Purpose**: track heap usage, event-loop lag, and GC pause time as a composite pressure signal, feeding load-shedding and persistence-throttling decisions.
- **Trigger**: continuous polling (default every 2 seconds) once `features.runtimeMetrics`/`eventLoopMonitoring`/`gcMonitoring` are enabled.
- **Captured data**: not directly exported as telemetry events by default — this is primarily an internal signal, though `getSDKHealth()` surfaces the derived memory state.
- **Disable**: the corresponding remote feature flag.
- **Performance impact**: designed to be cheap (histogram-based lag tracking, periodic sampling rather than continuous instrumentation).

### 4.6 Automatic console log capture

- **Purpose**: capture `console.log/info/warn/error/debug` calls as structured `log` events without requiring `captureLog()` calls.
- **Trigger**: any of those five console methods being called, once console capture is active.
- **Captured data**: level (normalized: `log`→`info`, `warn`→`warning`), message, up to 10 scrubbed arguments, trace/span/request correlation.
- **Disable**: the `logging` entitlement being revoked, or `features.logging` being off.
- **Limitations**: only the first library to wrap a given `console.*` method "wins"; if something else has already wrapped it, the SDK detects this and skips installing its own wrapper (logged as a warning) rather than double-wrapping.


---

## 5. Manual API Reference

All capture helpers are fail-open: internal failures are caught, logged, and swallowed — they never throw into application code. Sampling, killswitches, entitlements, rate limits, and queue capacity can still cause an event to be dropped.

### 5.1 `captureError(error, options?)`

**Signature:** `captureError(error: unknown, options?: CaptureErrorOptions | Record<string, unknown>): void`

**Parameters:**
- `error` — an `Error`, string, or any thrown value; normalized internally.
- `options.severity` — a `SeverityLevel`, default `'error'`.
- `options.fingerprint` — override the auto-generated grouping fingerprint.
- `options.context` — arbitrary additional data attached to the event.
- `options.mechanism` — how the error was captured, default `'manual'`.

**Return value:** `void`. **Throws:** never. **Async:** no (synchronous; the resulting pipeline processing is deferred internally, but the call itself returns immediately).

```ts
import { captureError } from '@vikasbaplawat1/pulse-sdk'

try {
  await chargeCard()
} catch (error) {
  captureError(error, {
    severity: 'error',
    mechanism: 'checkout.charge',
    fingerprint: 'checkout-charge-v2',
    context: { orderId: 'order_123', retry: false },
  })
}
```

**Common mistakes:** passing a plain object as the second argument expecting it to be treated as `context` when it *also* happens to contain a `severity`/`fingerprint`/`context`/`mechanism` key — in that case it is treated as `CaptureErrorOptions`, not as raw context, per the internal duck-typing check.

**Performance notes:** stack parsing and fingerprint generation run synchronously and are the most CPU-relevant part of this call; fingerprints are cached (1000 entries, 60s TTL) to avoid recomputing SHA-256 for repeated identical errors.

**Interaction with batching:** errors use `minBatchSize=1` on their route, so a captured error is generally sent within one flush interval (as low as ~1 second) rather than waiting for a full batch to accumulate.

**Interaction with sampling:** deterministic FNV-1a sampling keyed by the event's fingerprint (or event ID/message as fallback).

**Context requirements:** none required; if called inside a request context (via `withContext`), breadcrumbs and request ID are automatically attached.

**Edge cases:** a killed `disableErrors` killswitch makes this a complete no-op before any stack parsing occurs.

### 5.2 `captureMessage(message, severity?, context?)`

**Signature:** `captureMessage(message: string, severity: SeverityLevel = 'info', context?: Record<string, unknown>): void`

```ts
import { captureMessage } from '@vikasbaplawat1/pulse-sdk'

captureMessage('Inventory is below reorder threshold', 'warning', {
  sku: 'sku_123',
  remaining: 4,
})
```

**Return value:** `void`. **Throws:** never. **Async:** no. Messages are a distinct `message` event type; they are gated only by the global `disableSDK` killswitch (no per-type killswitch or entitlement applies to messages).

### 5.3 `captureRequest(event)`

**Signature:** `captureRequest(event: RequestEvent): void`

Submits a complete request event manually — the caller must supply all required `RequestEvent` fields (`requestId`, `method`, `url`, `statusCode`, `latency`, `timestamp`). Framework middleware (`monitorMiddleware`/`fastifyPulsePlugin`) is preferred for automatic capture; use this only when you need to report a request from outside those integrations.

```ts
import { captureRequest } from '@vikasbaplawat1/pulse-sdk'

captureRequest({
  type: 'request',
  requestId: 'req_123',
  method: 'GET',
  url: '/orders/:id',
  statusCode: 200,
  latency: 18,
  timestamp: Date.now(),
})
```

`traceId`/`spanId` are auto-filled from the active OTel span if the caller did not already set them.

### 5.4 `captureEvent(event)`

**Signature:** `captureEvent(event: SDKEvent | Event): EventReceipt`

The universal entry point every other capture function ultimately delegates to.

```ts
import { captureEvent } from '@vikasbaplawat1/pulse-sdk'

const receipt = captureEvent({
  type: 'message',
  message: 'cache warmed',
  severity: 'info',
  timestamp: Date.now(),
})

if (!receipt.accepted) {
  console.warn(receipt.reason)
} else {
  const processed = await receipt.processed
  console.log(receipt.eventId, processed)
}
```

**Return value:** an `EventReceipt`:

```ts
interface EventReceipt {
  readonly accepted: boolean
  readonly eventId: string
  readonly reason?: string | undefined
  readonly processed: Promise<boolean>
}
```

`accepted` means the event entered the local pipeline — it does not mean it was delivered. `processed` resolves once asynchronous pipeline processing completes (drop or success), and should only be awaited when you specifically need delivery-lifecycle confirmation (e.g., before a manual `flush()`).

### 5.5 `captureLog(level, message, ...args)`

**Signature:** `captureLog(level: SeverityLevel | 'log' | 'warn', message: string, ...args: unknown[]): void`

```ts
import { captureLog } from '@vikasbaplawat1/pulse-sdk'

captureLog('info', 'payment authorized', { paymentId: 'pay_123', amount: 4200 })
captureLog('warn', 'gateway latency high', { latencyMs: 850 })
```

Accepted levels: `debug`, `info`, `warning`, `warn` (normalizes to `warning`), `error`, `fatal`, `log` (normalizes to `info`). Up to 10 arguments are retained; all arguments are scrubbed with active privacy rules before transport. No-op when the `logging` entitlement is revoked or the logging subsystem is not running.

### 5.6 `captureReplay(sessionId, segmentId, events)`

**Signature:** `captureReplay(sessionId: string, segmentId: number, events: readonly unknown[]): void`

```ts
import { captureReplay } from '@vikasbaplawat1/pulse-sdk'

captureReplay('session_123', 0, [
  { kind: 'navigation', path: '/checkout', at: Date.now() },
])
```

Rejects an empty `sessionId` or an empty `events` array (no-op in either case). Sampled deterministically by `sessionId` alone (no route-based override applies to replays). This API accepts caller-provided entries — it does not itself record browser DOM mutations.

### 5.7 `startProfile(profileId)` / `stopProfile(profileId)`

**Signatures:** `startProfile(profileId: string): Promise<boolean>`, `stopProfile(profileId: string): Promise<void>`

```ts
import { startProfile, stopProfile } from '@vikasbaplawat1/pulse-sdk'

const started = await startProfile('month-end-close')
try {
  await runMonthEndClose()
} finally {
  if (started) await stopProfile('month-end-close')
}
```

Both are **CPU profiling only** — despite the underlying type system modeling a `'heap'` profile type, no heap-profiling start/stop path exists in the current implementation. `startProfile` returns `false` (and performs no work) when profiling is disabled, not yet initialized, not entitled, or sampled out by `SamplingEngine.shouldSampleProfile()`. `stopProfile` is a safe no-op if no matching profile is active. A profile automatically starts on the root span of any trace when tracing and profiling are both active (subject to the same sampling check) — you do not need to call `startProfile` manually inside a traced request unless you want a profile outside the normal span lifecycle.

### 5.8 Metrics

**Signatures:**
```ts
captureMetric(name: string, value: number, type?: 'counter' | 'gauge' | 'histogram', options?: { tags?: Record<string,string>; unit?: string }): void
incrementCounter(name: string, value?: number, tags?: Record<string,string>): void
setGauge(name: string, value: number, tags?: Record<string,string>): void
recordHistogram(name: string, value: number, tags?: Record<string,string>, unit?: string): void
addUpDownCounter(name: string, value: number, tags?: Record<string,string>): void
```

```ts
captureMetric('checkout.total', 1, 'counter', { tags: { region: 'us-east' } })
incrementCounter('orders.created', 1, { channel: 'web' })
setGauge('queue.depth', 42, { queue: 'billing' })
recordHistogram('http.server.duration', 37.5, { route: '/orders' }, 'ms')
addUpDownCounter('workers.active', -1, { pool: 'default' })
```

`captureMetric`'s `type` parameter defaults to `'gauge'` if omitted. Counters, gauges, and histograms recorded via any of these functions are aggregated by an OpenTelemetry-native registry using exponential histograms for O(1) recording; percentiles are computed downstream from raw bucket data, not by the SDK. `recordHistogram`'s `unit` parameter is currently accepted but not forwarded to the underlying registry call. Metric admission checks the `customMetrics` entitlement and the `disableMetrics` killswitch before any registry call. High-cardinality label keys (e.g., `userId`, `requestId`, `email`) are always stripped by an internal cardinality governor regardless of what you pass.

### 5.9 `captureCronCheckIn(monitorSlug, status, options?)`

**Signature:** `captureCronCheckIn(monitorSlug: string, status: 'in_progress' | 'ok' | 'error', options?: { duration?: number; environment?: string }): void`

```ts
import { captureCronCheckIn } from '@vikasbaplawat1/pulse-sdk'

const startedAt = Date.now()
captureCronCheckIn('billing-sync', 'in_progress')
try {
  await syncBilling()
  captureCronCheckIn('billing-sync', 'ok', { duration: Date.now() - startedAt })
} catch (error) {
  captureCronCheckIn('billing-sync', 'error', { duration: Date.now() - startedAt })
  throw error
}
```

An `'in_progress'` check-in without a matching `'ok'`/`'error'` within 5 minutes automatically produces a synthetic `'error'` check-in (timeout detection). This timeout tracking only starts once the cron subsystem exists post-initialization — a pre-init `'in_progress'` check-in is buffered but its timeout clock does not start until `createSDK()` completes. No-op entirely if the `crons` entitlement is revoked.

### 5.10 Scope, context, and breadcrumbs

```ts
import {
  setUser, setTags, setExtra, setContext, withScope,
  createContextStore, withContext, addBreadcrumb, getRequestContext,
  captureError,
} from '@vikasbaplawat1/pulse-sdk'

setUser({ id: 'user_123', email: 'person@example.test' })
setTags({ region: 'us-east', component: 'checkout' })
setExtra('attempt', 2)
setContext('order', { id: 'order_123', value: 4200 })

withScope(scope => {
  scope.setTag('operation', 'refund')
  captureError(new Error('refund failed'))
})

const store = createContextStore('req_123', 100, {
  userId: 'user_123',
  sessionId: 'session_123',
  extra: { tenantId: 'tenant_123' },
})

await withContext(store, async () => {
  addBreadcrumb({
    category: 'checkout',
    message: 'authorization requested',
    level: 'info',
    data: { orderId: 'order_123' },
  })
})
```

- `setUser`/`setTag(s)`/`setExtra(s)`/`setContext` mutate the **active scope** — the `withScope()` clone if inside one, otherwise a global fallback scope. `setUser` runs email/username/IP through PII scrubbing before storing.
- `withScope(fn)` clones the current scope, propagates the clone through the OpenTelemetry context for the duration of `fn`, and never mutates the parent scope.
- `addBreadcrumb()` is a no-op **outside** an active `ContextStore` (i.e., outside `withContext`/framework middleware) — there is no global breadcrumb buffer that this function writes to as a fallback.
- Merge precedence when an event is enriched: request `ContextStore` values win over active-scope values, which win over the event's own pre-existing values (which are never overwritten).
- Tag/extra/context keys of `__proto__`, `constructor`, or `prototype` are silently rejected (prototype-pollution guard) — they do not throw, they simply have no effect.

### 5.11 Tracing

```ts
import { startSpan, withSpan, withSpanSync, getActiveSpan, flushTracer } from '@vikasbaplawat1/pulse-sdk'

const result = await withSpan('checkout.authorize', async span => {
  span.setAttributes({
    'checkout.order_id': 'order_123',
    'checkout.gateway': 'primary',
  })
  span.addEvent('authorization.started')
  return authorizePayment()
}, { timeoutMs: 5_000 })
```

`withSpan(name, fn, options?)` is the preferred custom-span API: it installs the span as the *active* span for the callback's async lifetime (so child work, including auto-instrumented calls, correctly nests under it), records thrown errors, rethrows the original error unmodified, and always ends the span exactly once. `withSpanSync` is the synchronous equivalent for non-async callbacks.

`startSpan(name, options?)` returns a `PulseSpan` but **does not** make it the active span — auto-instrumented work or further `withSpan` calls after it will *not* become its children. Use it only for spans you manage entirely manually and end yourself; there is no auto-close.

`getActiveSpan()` returns the currently active span (or `null`). `flushTracer()` force-flushes finished spans into the pipeline without shutting down the tracer.

If a `timeoutMs` option is set on `withSpan`/`withSpanSync`, exceeding it force-ends the span with an error status and a `pulse.span.timeout` event — **the underlying async work is not cancelled**; only the span's lifecycle is affected.

`PulseSpan` methods (`setAttribute`, `setAttributes`, `addEvent`, `addLink`, `addLinks`, `recordError`, `recordException`, `updateName`, `setStatus`, `end`) are all fluent (return `this`), never throw, and become no-ops after `end()` has been called once.

### 5.12 Manual header propagation

```ts
import { injectTraceContext, extractTraceContext, withSpan } from '@vikasbaplawat1/pulse-sdk'

await withSpan('publish.invoice', async () => {
  const headers: Record<string, string> = {}
  injectTraceContext(headers)
  await publishInvoice({ headers })
})

const extractedContext = extractTraceContext(incomingHeaders)
```

`injectTraceContext` adds standard W3C trace-context headers (when enabled internally, which is the default) plus three custom `x-pulse-*` headers for non-OTel consumers. `extractTraceContext` returns an OpenTelemetry `Context` object; activating it for further work requires the OpenTelemetry context APIs directly — built-in HTTP/framework instrumentation activates extracted context automatically for incoming requests.

### 5.13 Plugins

```ts
import { createSDK } from '@vikasbaplawat1/pulse-sdk'
import type { SDKPlugin } from '@vikasbaplawat1/pulse-sdk'

const plugin: SDKPlugin = {
  meta: { name: 'deployment-tags', version: '1.0.0' },
  setup(context) {
    console.log('Project:', context.metadata.projectId)
  },
  processEvent(event) {
    return { ...event, deploymentRing: 'canary' } as typeof event
  },
  beforeSend(event) {
    return event
  },
  afterSend(events) {
    console.log('sent', events.length)
  },
  teardown() {},
}

await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  plugins: [plugin],
})
```

Plugin `meta.name` must be unique — registering a second plugin with a duplicate name throws. Hooks run in registration order; `processEvent`/`beforeSend` are each individually timeout-bounded (50ms/100ms respectively) and returning `null` from either drops the event. A plugin's `setup()` runs once during initialization; `teardown()` runs during shutdown, in reverse registration order.

---

## 6. SDK Lifecycle

```ts
import { flush, shutdown, crashFlush } from '@vikasbaplawat1/pulse-sdk'

await flush() // drain pipeline, transport, and persistence; SDK stays active

const result = await shutdown(10_000)
if (!result.completed) {
  console.warn({
    timedOut: result.timedOut,
    remainingEvents: result.remainingEvents,
    stepErrors: result.stepErrors,
  })
}

await crashFlush(2_000) // crash path only
```

- **Initialization**: `createSDK(options)` / `init(options)`.
- **Running**: capture APIs are available immediately after a successful `createSDK()` resolution; calls before that point are buffered (bounded queue) and replayed once initialization completes.
- **Flush**: `flush()` drains the pipeline, flushes every transport route, and flushes persistent storage, without tearing down any subsystem. Safe to call at any time.
- **Close/Shutdown**: `shutdown(timeoutMs?)` rejects new captures, tears down every subsystem, flushes what it can within the deadline, persists whatever could not be delivered, and resets all global state. It never throws and always resolves with a `ShutdownResult`.
- **Restart**: after `shutdown()` resolves (or its background cleanup finishes, if it timed out), a subsequent `createSDK()` call starts from a genuinely clean slate — every singleton, timer, and process listener is reset.

`ShutdownResult`:

```ts
interface ShutdownResult {
  readonly completed: boolean
  readonly timedOut: boolean
  readonly durationMs: number
  readonly remainingEvents: number
  readonly deadLetterCount: number
  readonly stepErrors: readonly { readonly step: string; readonly error: unknown }[]
}
```


---

## 7. TypeScript Reference

### 7.1 Event types (discriminated union)

```ts
type SDKEvent =
  | RequestEvent | ErrorEvent | MessageEvent | MetricEvent
  | SpanEvent | TraceEvent | LogEvent | ProfileEvent | ReplayEvent | CronCheckInEvent
```

Ten variants, discriminated by `type`. `EventMetadata` is attached to every event automatically:

```ts
interface EventMetadata {
  readonly sdkName: string
  readonly sdkVersion: string
  readonly applicationName: string
  readonly applicationVersion: string
  readonly projectId: string
  readonly environment: string
  readonly release: string
  readonly serverName?: string
}
```

`StackFrame`:

```ts
interface StackFrame {
  readonly filename: string
  readonly function: string
  readonly lineno?: number | undefined
  readonly colno?: number | undefined
  readonly inApp: boolean
  readonly module?: string | undefined
  readonly sourceContext?: { readonly pre: readonly string[]; readonly line: string; readonly post: readonly string[] } | undefined
}
```

### 7.2 Severity

```ts
const Severity = { Debug: 'debug', Info: 'info', Warning: 'warning', Error: 'error', Fatal: 'fatal' } as const
type SeverityLevel = (typeof Severity)[keyof typeof Severity]
function severityFromString(value: string | undefined | null, fallback?: SeverityLevel): SeverityLevel
```

`Severity` is a plain frozen object with string values, not a TypeScript `enum` — use `Severity.Error`, not `SeverityLevel.Error`.

### 7.3 Breadcrumbs

```ts
interface Breadcrumb {
  readonly timestamp: string
  readonly category: string
  readonly message?: string | undefined
  readonly level: SeverityLevel
  readonly type: BreadcrumbType
  readonly data?: Readonly<Record<string, unknown>> | undefined
}
type BreadcrumbType = 'default' | 'http' | 'navigation' | 'error' | 'query' | 'ui' | 'user' | 'info' | 'debug'
interface BreadcrumbInput {
  readonly category: string
  readonly message?: string
  readonly level?: SeverityLevel
  readonly type?: BreadcrumbType
  readonly data?: Readonly<Record<string, unknown>>
}
```

### 7.4 Plugins

```ts
type EventProcessor = (event: SDKEvent) => SDKEvent | null | Promise<SDKEvent | null>
type BreadcrumbProcessor = (breadcrumb: Breadcrumb, hint?: BreadcrumbHint) => Breadcrumb | null

interface PluginMeta { readonly name: string; readonly version: string }
interface PluginContext {
  readonly config: Readonly<RemoteConfigResponse>
  readonly metadata: Readonly<{ projectId: string; environment: string; release: string; sdkVersion: string }>
}
interface SDKPlugin {
  readonly meta: PluginMeta
  setup?(context: PluginContext): void | Promise<void>
  processEvent?(event: SDKEvent): SDKEvent | null | Promise<SDKEvent | null>
  processBreadcrumb?(breadcrumb: Breadcrumb, hint?: BreadcrumbHint): Breadcrumb | null
  beforeSend?(event: SDKEvent): SDKEvent | null | Promise<SDKEvent | null>
  afterSend?(events: readonly SDKEvent[]): void
  beforeFlush?(): void
  onTransportError?(error: Error, events: readonly SDKEvent[]): void
  teardown?(): void | Promise<void>
}
```

### 7.5 Tracing

```ts
type SpanStatus = 'ok' | 'error' | 'unset'
interface SpanOptions {
  attributes?: Attributes
  startTime?: TimeInput
  links?: SpanLink[]
  timeoutMs?: number
}
interface SpanLink { traceId: string; spanId: string; attributes?: Attributes }
```

`withSpan` and `withSpanSync` are overloaded to accept the callback either first or second relative to `options` — both call signatures below are valid:

```ts
withSpan<T>(name: string, fn: (span: PulseSpan) => T | Promise<T>, options?: SpanOptions): Promise<T>
withSpan<T>(name: string, options: SpanOptions, fn: (span: PulseSpan) => T | Promise<T>): Promise<T>
```

### 7.6 Error types

```ts
interface CaptureErrorOptions {
  severity?: SeverityLevel
  fingerprint?: string
  context?: Record<string, unknown>
  mechanism?: string
  tags?: Record<string, string>
}
interface ParsedError { readonly name: string; readonly message: string; readonly stack: readonly StackFrame[]; readonly cause?: ParsedError }
interface ErrorGrouping { readonly fingerprint: string; readonly title: string; readonly inAppFrameCount: number }
```

Note: `CaptureErrorOptions.tags` is declared here but is not currently read by `captureError()`'s implementation — passing it has no effect (see `AUDIT_REPORT.md` §7).

### 7.7 Scope

```ts
interface User {
  id?: string | undefined
  email?: string | undefined
  username?: string | undefined
  ipAddress?: string | undefined
  data?: Record<string, unknown> | undefined
}
interface ScopeData {
  user: User | null
  tags: Record<string, string>
  extra: Record<string, unknown>
  contexts: Record<string, Record<string, unknown>>
}
```

### 7.8 Context store

```ts
interface ContextStore {
  readonly requestId: string
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly userId?: string | undefined
  readonly sessionId?: string | undefined
  readonly baggage?: Readonly<Record<string, string>> | undefined
  readonly breadcrumbs: RingBuffer<Breadcrumb>
  readonly tags?: Readonly<Record<string, string>> | undefined
  readonly extra?: Readonly<Record<string, unknown>> | undefined
}
```

### 7.9 Framework middleware options

```ts
interface PulseExpressOptions {
  readonly ignorePaths?: readonly (string | RegExp)[]
  readonly ignoreMethods?: readonly string[]
  readonly maxBreadcrumbs?: number
  readonly trustedProxies?: readonly string[]
}
interface PulseFastifyOptions {
  readonly ignorePaths?: readonly (string | RegExp)[]
  readonly ignoreMethods?: readonly string[]
  readonly maxBreadcrumbs?: number
  readonly trustedProxies?: readonly string[]
}
```

### 7.10 `SDKInitOptions`

```ts
interface SDKInitOptions {
  readonly apiKey: string
  readonly applicationName?: string
  readonly applicationVersion?: string
  readonly packageJsonPath?: string
  readonly maxBreadcrumbs?: number
  readonly plugins?: readonly SDKPlugin[]
  readonly eventProcessors?: readonly EventProcessor[]
  readonly beforeBreadcrumb?: BreadcrumbProcessor
  readonly beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
  readonly debug?: boolean
  readonly logLevel?: SeverityLevel
  readonly baseUrl?: string
  readonly shutdownTimeoutMs?: number
  readonly sourceMaps?: {
    readonly paths?: readonly string[]
    readonly allowRemote?: boolean
    readonly embedSourceContent?: boolean
  }
}
```

### 7.11 Utility types

`EntitlementsConfig` (10 booleans: `customSpans`, `customMetrics`, `profiling`, `logging`, `sessionReplay`, `crons`, `requestCapture`, `tracing`, `errors`, `metrics`) is a public type describing which optional capabilities are billed/entitled — you cannot set these locally; they are read-only reflections of the active remote snapshot, obtainable via `getConfig().entitlements`.

`RemoteConfigResponse` is the complete public type of the active immutable configuration snapshot, returned by `getConfig()` and by `createSDK()`/`init()` on success.


---

## 8. Troubleshooting

**Why don't my errors appear?**
Confirm `createSDK()` resolved to a defined value (not `undefined`), the API key is correct, `features.errors` and the `errors` entitlement are both active, and `killswitches.disableErrors`/`disableSDK` are not set. Check `getSDKHealth().circuitState` for the `errors` route.

**Why aren't spans created?**
Ensure the SDK was initialized *before* the instrumented library was imported/required. Prefer `withSpan()` over `startSpan()` when child work needs to nest under the span. Confirm `features.tracing` and the `tracing` entitlement are active, and the specific instrumentation flag (`instrumentation.http`, etc.) is enabled.

**Why is sampling dropping events?**
Sampling is deterministic by a stable key (fingerprint, trace ID, request ID, etc.) — the same identifier always produces the same decision. Check the relevant `sampling.*` rate and any matching `sampling.routes` prefix override; a rate of `0` on a matching prefix always drops that family for that route.

**Why isn't batching flushing?**
Each route has a minimum batch size (as low as 1 for errors/crons/profiles/replays/generic events, higher for metrics/traces/spans/requests/logs) and a maximum wait time. If neither threshold has been reached, the batch is still accumulating — call `flush()` to force an immediate send.

**Why is transport failing?**
Check `getSDKHealth().circuitState` — a route enters an open-circuit state after repeated failures and will not send again until a backoff-scheduled probe succeeds. Confirm outbound network access to the configured origin.

**Why isn't Express detected?**
Confirm the SDK was initialized before `express` was required, and that `instrumentation.express` plus the `tracing` entitlement are active. `monitorMiddleware()` itself does not create spans; it enriches spans created by the underlying OTel Express instrumentation.

**Why isn't Fastify detected?**
Same as Express — initialization order and the `instrumentation.fastify`/`tracing` flags.

**Why are requests missing?**
Check `ignorePaths`/`ignoreMethods` on your middleware options, `features.requestCapture`, the `requestCapture` entitlement, and route-based sampling.

**Why are stack traces incomplete?**
`Error.stackTraceLimit` is set to an internal default (50 frames) when global error handlers are installed. Very deep call stacks beyond that will be truncated.

**Why are traces disconnected?**
Ensure `withSpan()` (not `startSpan()`) is used for any span that should be the active parent of subsequent work; `startSpan()` deliberately does not activate its span.

**Why are metrics delayed?**
Metrics use exponential-histogram aggregation with a periodic flush (an internal timer, not per-call); expect metrics to appear on that cadence, not instantly per call.

**Why is remote config ignored?**
There is no local override mechanism — everything behavior-affecting comes from the backend. If a change does not appear to take effect, confirm the backend actually served a new snapshot; the SDK only re-fetches configuration after a telemetry acknowledgment explicitly signals a change, not on a timer.

**Why are events rejected?**
Check `receipt.reason` from `captureEvent()`'s return value, or the SDK's debug logs — reasons include `sdk_shutting_down`, `sdk_disabled_by_killswitch`, `load_shed`, `pre_init_queue_full`, and `pipeline_overloaded`, among others.

**How do I debug the SDK?**
Pass `debug: true` to `createSDK()`, or call `setDebugMode(true)`/`setLogLevel('debug')` directly.

**How do I enable verbose logs?**
Beyond `debug: true`, two undocumented-in-README environment variables exist in the codebase: `PULSE_TRANSPORT_CONSOLE=true` (dumps transport request/response details, with the Authorization header redacted) and `PULSE_SDK_CONSOLE_DEBUG=true` (dumps general pipeline/event debug output). Either enables extra `console.log` output beyond the normal logger.

**How do I test locally?**
Set `baseUrl` (or `SDK_BASE_URL`) to a local/staging control-plane origin.

**How do I flush manually?**
`await flush()`.

**How do I verify instrumentation?**
Call `getSDKHealth()` and inspect `circuitState`; check the SDK's info-level log line emitted after `registerAutoInstrumentations()` runs, which lists every instrumentation flag's resolved boolean value.

**How do I disable features?**
Features are backend-controlled — there is no local toggle. Contact whoever manages your project's remote configuration.

**How do I reduce overhead?**
Lower sampling rates, disable unneeded `instrumentation.*` flags remotely, keep payload/body/header capture off unless specifically needed, and avoid high-cardinality metric tags (the SDK already strips a hardcoded list of known-bad keys, but application-specific high-cardinality tags are not caught by that list).


---

## 9. FAQ

**General**

1. **What Node.js version do I need?** 18 or newer — the SDK relies on global `fetch`.
2. **Is this SDK CommonJS or ESM?** Pure ESM (`"type": "module"`).
3. **Do I need to install TypeScript types separately?** No, they ship with the package.
4. **What happens if `createSDK()` fails?** It returns `undefined`; application code continues without telemetry, and the failure is logged internally.
5. **Can I call `createSDK()` twice?** With the same API key, yes (idempotent, returns the existing config). With a different key while initialized, it throws.
6. **Does the SDK read `PULSE_API_KEY` automatically?** No — you must pass `apiKey` explicitly; any environment-variable convention is application-level, not SDK behavior.
7. **What is `baseUrl` for?** Overriding the control-plane origin (local/staging/self-hosted). It only accepts a bare HTTP(S) origin.
8. **Is `SDK_BASE_URL` the same as `baseUrl`?** `SDK_BASE_URL` is an environment-variable fallback; an explicit `baseUrl` option takes precedence.
9. **Does the SDK poll for configuration?** No — there is no periodic polling anywhere in the codebase.
10. **How does the SDK learn about configuration changes?** Only via a signal embedded in a telemetry acknowledgment (`status: 202, change: true`), which triggers exactly one background refresh request.

**Errors**

11. **Does `captureError` throw if something goes wrong internally?** No — it is wrapped in a try/catch that logs and swallows any internal failure.
12. **What is a fingerprint?** A deterministic grouping key computed from the error type, in-app stack frames, and a normalized message (numbers, UUIDs, and quoted strings replaced with placeholders).
13. **Can I override the fingerprint?** Yes, via `options.fingerprint`.
14. **What does `mechanism` mean?** How the error was captured — `'manual'` (default), `'uncaughtException'`, `'unhandledRejection'`, `'console.error'`, or any custom string you pass.
15. **Are duplicate errors suppressed?** Yes, within a 60-second window, keyed by fingerprint plus project/release/tenant/route.
16. **Does the SDK read source maps?** Only if configured via `sourceMaps` options, and resolution is deferred to async pipeline processing so it never blocks the capture call itself.
17. **Are error messages scrubbed?** Yes, before they leave the process, using the same scrubbing engine as other payloads.
18. **What happens to breadcrumbs attached to an error?** They are also individually scrubbed.
19. **Can I attach custom tags to an error?** Via `context`, or via `withScope()`/`setTags()` beforehand — not via the currently-unused `options.tags` field.
20. **Does capturing an error affect the active span?** Yes — if a span is active, the error is recorded on it (`recordException` + error status) as a best-effort side effect.

**Messages and logs**

21. **What severities are valid for `captureMessage`?** `debug`, `info`, `warning`, `error`, `fatal`.
22. **Is `captureMessage` gated by any killswitch besides the global one?** No — only `disableSDK`.
23. **What's the difference between `captureMessage` and `captureLog`?** `captureMessage` always emits a `message` event and is never entitlement-gated; `captureLog` emits a structured `log` event, is gated by the `logging` entitlement, and supports up to 10 additional structured arguments.
24. **How many log arguments are kept?** Up to 10.
25. **Are log arguments scrubbed?** Yes, with the same active privacy rules as everything else.
26. **Does `warn` normalize to anything?** Yes — `warn` becomes `warning`.
27. **Does `log` normalize to anything?** Yes — `log` becomes `info`.
28. **Is console output automatically captured?** Only if console interception is active (backend-controlled); explicit `captureLog()` calls work independently of that.

**Metrics**

29. **What metric types are supported via `captureMetric`?** `counter`, `gauge`, `histogram`.
30. **What's the default type if I don't specify one?** `gauge`.
31. **How is `addUpDownCounter` different from `captureMetric`?** It is its own dedicated function, not reachable via `captureMetric`'s type parameter.
32. **Does the SDK compute percentiles locally?** No — it records into exponential histograms and lets the backend compute percentiles from the raw bucket data.
33. **Can I use `userId` as a metric tag?** No — it is one of a hardcoded list of always-blocked high-cardinality attribute keys.
34. **Are dynamic route segments normalized in metric tags?** Yes, for known route-shaped attribute keys (`http.route`, `path`, etc.) — numeric segments, UUIDs, and Mongo-style IDs become `:id`.
35. **Is there a limit on the number of distinct metric names?** Yes, an internal cap (500) on distinct registered metric names.
36. **Is there a per-metric cardinality limit?** Yes, an internal cap (1000 series per metric, 2000 total) enforced before recording.

**Tracing**

37. **What's the difference between `startSpan` and `withSpan`?** `startSpan` does not activate its span (children won't nest under it automatically); `withSpan` does, and also handles error recording and guaranteed span-ending for you.
38. **Do I need to call `span.end()` after `startSpan`?** Yes, exactly once — there is no auto-close.
39. **What happens if `withSpan`'s callback throws?** The error is recorded on the span, the span is marked with error status, the span ends, and the original error is rethrown unmodified.
40. **Can I set a timeout on a span?** Yes, via `options.timeoutMs` on `withSpan`/`withSpanSync`/`startSpan`.
41. **Does a span timeout cancel my code?** No — only the span's lifecycle is force-ended; your async work continues.
42. **How do I get the current trace ID?** `getTraceId()`.
43. **How do I get the current span ID?** `getSpanId()`.
44. **Can I link spans that aren't parent/child?** Yes, via `options.links` at span creation, or `span.addLink()`/`addLinks()` afterward.
45. **Does `startSpan` respect the `customSpans` entitlement?** Yes — if revoked, it returns a non-recording no-op span instead of a real one.
46. **Are automatically-instrumented spans affected by the `customSpans` entitlement?** No — that entitlement only gates the developer-facing manual span APIs, not automatic instrumentation.

**Requests**

47. **Do I need to call `captureRequest` if I'm using `monitorMiddleware`?** No — the middleware calls it for you.
48. **What IP address is attached to a request event?** By default, a SHA-256 hash of the resolved client IP, truncated to 16 hex characters — not the raw IP.
49. **When are forwarded-IP headers trusted?** Only when the immediate socket peer matches an entry in `trustedProxies` (or `trustedProxies` includes `'*'`).
50. **Does Fastify's own `trustProxy` setting matter?** Yes — `request.ip` (which already respects Fastify's own trust-proxy configuration) takes precedence over the SDK's own IP resolution when present.


51. **What is the maximum body size inspected for capture?** 64 KB — larger bodies are marked truncated rather than attached.
52. **Are non-JSON request bodies captured?** No — only object-shaped bodies are attached; strings/Buffers are reported by size only.

**Sampling**

53. **Is sampling random?** No — deterministic, based on an FNV-1a hash of a stable identifier.
54. **Will the same trace always get the same sampling decision?** Yes, as long as the sampling rate configuration hasn't changed.
55. **Can I silence a specific route entirely?** Yes, by setting a rate of `0` for that event family under a matching `sampling.routes` prefix.
56. **Do route overrides use exact match or prefix match?** Longest-prefix match.
57. **Are errored traces always kept even if unsampled?** Spans carrying an error status or exception event are promoted to export even if the trace root was not sampled.

**Configuration**

58. **Can I set feature flags locally?** No — they are entirely backend-controlled.
59. **What happens if the backend sends an invalid configuration?** The entire snapshot is rejected; the previous valid snapshot (or none, at boot) remains active.
60. **Is partial configuration merging supported?** No — a snapshot is applied entirely or not at all.
61. **What's the difference between a feature flag and a killswitch?** A feature flag decides whether a subsystem exists at all; a killswitch is an emergency stop independent of that.
62. **What's the difference between a killswitch and an entitlement?** A killswitch is operational (emergency stop); an entitlement is a billing/plan gate on optional developer-facing APIs.
63. **Are core APIs (captureError, captureMessage, scope, flush, shutdown) entitlement-gated?** No — these are treated as fundamental regardless of plan.
64. **How many killswitches exist?** Seven: `disableSDK`, `disableTracing`, `disableMetrics`, `disableTransport`, `disableProfiling`, `disableErrors`, `disableLogs`.

**Transport and delivery**

65. **Is delivery guaranteed exactly-once?** No — at-least-once. The backend must deduplicate by `eventId`.
66. **Why might I see duplicate events?** A response lost after the backend already accepted the batch causes a client-side retry of an already-delivered batch.
67. **Is compression always used?** Yes, gzip, for the primary telemetry send path, regardless of the configured per-route compression setting.
68. **Is there retry jitter?** No — retry delay is a deterministic function of the backoff strategy and attempt number.
69. **What HTTP statuses trigger a retry?** 5xx, 429, and 408.
70. **What HTTP statuses are treated as permanent failures?** Any other 4xx.
71. **Are permanently-rejected batches persisted to disk?** No — only retry-eligible failures are.
72. **Does the SDK persist every event to disk as a durability guarantee?** No — persistence is fallback-only, triggered by an actual send failure or a shutdown-time drain timeout, specifically to avoid replaying already-delivered events on every restart.

**Lifecycle**

73. **Does `shutdown()` throw?** Never — it always resolves with a `ShutdownResult`.
74. **What happens if `shutdown()` times out?** Cleanup continues in the background; a subsequent `init()` will wait for that cleanup to finish before starting.
75. **Is `flush()` the same as `shutdown()`?** No — `flush()` drains without tearing anything down; the SDK remains active afterward.
76. **What is `crashFlush()` for?** A lightweight, hard-timeout-bounded drain intended for crash paths (e.g., inside an `uncaughtException` handler), skipping subsystem/plugin teardown entirely.
77. **Are SIGTERM/SIGINT handled automatically?** Yes, once registered (which happens automatically after successful initialization) — both trigger graceful `shutdown()`.
78. **Can SIGKILL be handled?** No — it cannot be intercepted by any Node.js process.

**Privacy**

79. **Is body capture on by default?** No — capture of headers, body, response, query, and cookies should be off unless explicitly enabled remotely.
80. **What happens to sensitive headers?** They are redacted based on a configurable list plus internal defaults, before transport.
81. **Is PII masking automatic?** Only if `piiDetection.enabled` and the relevant sub-flags (`maskEmails`/`maskPhones`/`maskIPs`) are on remotely.
82. **Are client IPs masked by default?** Yes — hashed, not raw, unless PII IP-masking is explicitly disabled.
83. **Is `beforeSend` a reliable privacy control?** It should be treated as a final filter, not the sole privacy mechanism — hook failures fail open to continued processing.

**Plugins**

84. **Can two plugins have the same name?** No — registration throws on a duplicate `meta.name`.
85. **What happens if a plugin's `setup()` throws?** It is logged and isolated — other plugins still initialize.
86. **In what order do plugin hooks run relative to user hooks?** Plugin `processEvent` (registration order) then user `eventProcessors` then user `beforeSend` then plugin `beforeSend` (registration order).
87. **Can a plugin override the SDK's own metadata (project ID, version, etc.)?** No — that metadata is force-reassigned after every hook runs.

**Instrumentation**

88. **Does the SDK avoid tracing its own network calls?** Yes — both the control-plane calls and the telemetry batch sends are wrapped in OpenTelemetry's `suppressTracing`, specifically to prevent unbounded export recursion.
89. **What happens if I import an instrumented library before initializing the SDK?** It may not be patchable — initialize the SDK first.
90. **Are BullMQ bulk/flow jobs specially handled?** Yes — separate controls exist for bulk-job spans, flow-job spans, and whether a parent span is required before creating a publish span.
91. **Does the SDK support Axios instances created via `axios.create()`?** Yes — the patch targets the shared prototype method, which both the default instance and created instances inherit.
92. **Is Prisma parameter capture fully prevented when disabled?** Not at the instrumentation layer — the underlying library has no such hook; redaction, where applied, happens downstream in generic scrubbing.

**Sessions and profiling**

93. **How long before an idle session ends?** 30 minutes of inactivity by default.
94. **What's the maximum session duration?** 4 hours by default.
95. **Does one error mark a session as crashed permanently?** Within that session's lifetime, yes — once crashed, it stays crashed until the session ends.
96. **Can I profile outside of a traced request?** Yes, via the manual `startProfile`/`stopProfile` API.
97. **Is heap profiling supported?** No, despite being modeled in the type system — only CPU profiling is implemented.
98. **What triggers automatic profiling?** The root span of a trace, when both tracing and profiling features are active and the trace passes profiling-specific sampling.

**Miscellaneous**

99. **Can I run this SDK in a worker thread and get the same trace correlation as the main thread?** Not automatically — OpenTelemetry context intentionally stays on the main thread; a worker-context serialization module exists in the codebase but currently has no exported entry point.
100. **Does the SDK auto-detect if I'm running in a container or serverless environment?** Yes — it detects Docker, Kubernetes downward-API environment variables, and several serverless platforms (AWS Lambda, GCP Cloud Run/Functions, Azure Functions) for resource attribute enrichment.
101. **Is there a way to see a full health snapshot of the SDK?** Yes, `getSDKHealth()`.
102. **Does `getSDKHealth()` require the SDK to be initialized?** No — it is safe to call at any time and returns degraded/default values if not initialized.


---

## 10. Migration Guide

No prior major-version migration notes are present in this repository beyond internal source comments describing an earlier (pre-current) architecture that persisted every event unconditionally and computed percentiles by sorting raw metric samples — both were replaced by the fallback-only persistence model and OTel-native histogram aggregation described throughout this guide. No versioned migration document (e.g., "v2 to v3") exists in the codebase — **Not Found In Codebase**.

One concrete, test-verified fact is available if you are migrating from an older integration that set local policy directly: the current `SDKInitOptions` schema explicitly rejects a specific set of field names that an older version of this SDK once accepted as local options — `service`, `environment`, `release`, `configUrl`, `enableErrors`, `enableTracing`, `enableMetrics`, `sampleRate`, `transport` (as a local option, distinct from the remote configuration's own `transport` section), `dataScrubbing`, and `otelMetrics` (confirmed by `init-options.test.ts`'s explicit rejection tests for each name). If your integration code still passes any of these, initialization will fail validation immediately with `SDKError('INVALID_INIT_OPTIONS')`. The replacement for all of them is the same: remove the local field entirely and configure the equivalent behavior on the backend, since project identity, feature enablement, sampling rates, and privacy/scrubbing policy are now exclusively backend-driven (see §3.2). Beyond this specific, provable rejection list, no further detail about what the old fields' exact semantics were is available — **Not Found In Codebase**.

---

## 11. Best Practices

- Initialize the SDK as the first thing your application does, before requiring any library you want auto-instrumented.
- Prefer `withSpan()` over `startSpan()` for any span whose children should nest under it.
- Use `withScope()` around logically distinct units of work (a single job, a single request handler) rather than mutating the global scope, to avoid state leaking between unrelated operations.
- Treat `beforeSend` as a last-resort filter, not your primary privacy control — privacy policy is backend-owned for a reason (centralized change without redeploy).
- Call `flush()` before intentionally exiting a short-lived process (scripts, serverless invocations) rather than relying solely on process-exit timing.
- Register your own `SIGTERM` handler in long-running workers if you need to control the process's own exit code alongside the SDK's `shutdown()`.
- Keep plugin hooks fast — they run inside per-hook timeout budgets (50-100ms) and a slow hook simply gets skipped, its work discarded for that event.

## 12. Performance Recommendations

**High throughput:** rely on the built-in batching (do not call `flush()` after every single capture); keep metric tag cardinality low; disable payload/body capture you don't need.

**Low latency:** capture calls themselves are synchronous and fast (network I/O is always deferred); avoid synchronous, large `context` objects on `captureError`/`captureMessage` calls since normalization walks and truncates them.

**Serverless:** call `flush()` (or `shutdown()` if the function will not be reused) before returning from the handler, since a frozen/terminated execution environment may not run the SDK's own signal-handler-based shutdown path.

**Containers:** the SDK auto-detects container memory limits (cgroup v1/v2) when `limits.maxMemoryMb` is set to `'auto'` remotely, applying a conservative 50% utilization factor.

**Large monoliths:** the entitlement gate and killswitch checks are plain property lookups on the hot path — enabling many subsystems does not by itself introduce meaningful per-event overhead beyond what each subsystem's own processing requires.

**Microservices:** ensure W3C trace-context propagation is not disabled if you need cross-service trace correlation; `injectTraceContext`/`extractTraceContext` are your manual escape hatch when automatic HTTP instrumentation is not enough (e.g., non-HTTP transports).

**Cron jobs:** use `minBatchSize=1` routes (cron check-ins flush essentially immediately) — there is no need to batch check-ins yourself.

**Workers:** correlate work manually via `withSpan`/`ContextStore` on the main thread; do not expect automatic trace propagation into a `worker_threads` worker.

## 13. Security

- **API keys**: pass via `apiKey` at initialization; never hardcode in source. The SDK validates the key is non-empty and free of control characters before it is ever transmitted.
- **Sensitive data**: keep `privacy.capture.*` (headers/body/response/query/cookies) off remotely unless a specific integration genuinely requires it, and add any organization-specific secret field/header names to the remote scrubbing configuration.
- **PII**: enable `privacy.piiDetection` sub-flags remotely if you want automatic email/phone/IP masking in free-form text fields; this is heuristic pattern matching, not a certified PII-detection system.
- **Headers**: `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, and `Proxy-Authorization` are redacted by a hardcoded default list in addition to whatever you configure remotely.
- **Body capture**: off by default; when enabled, bodies larger than 64 KB are marked truncated rather than fully attached, and scrubbing still applies to whatever is attached.
- **Masking**: client IPs are hashed (not raw) by default. Never place credentials in span names, metric names/tags, route names, or monitor slugs — these are treated as identifiers, not payload, and are not subject to the same scrubbing rules as `context`/`body`/`attributes`.
- **GDPR / compliance**: this document describes technical capabilities only (data minimization via sampling/limits, redaction, masking); it is not legal guidance, and no specific compliance certification claim is made anywhere in the codebase — **Not Found In Codebase** for any such claim.
