# Pulse SDK for Node.js

`@vikasbaplawat1/pulse-sdk` is an ESM Node.js observability SDK for errors, requests, messages, traces, metrics, structured logs, profiles, replay segments, and cron check-ins. This guide describes the public root export only; examples intentionally do not use the unsupported `internals` subpath.

- [Architecture](docs/ARCHITECTURE.md)
- [Feature and gate matrix](docs/FEATURES.md)
- [Operations and audit status](docs/WORKING.md)
- [Event wire types](docs/EVENT_TYPES.md)

> Delivery and capture are best-effort. Capture calls are designed not to break application control flow, but acceptance is not proof of backend delivery. Durable recovery is fallback-only and at-least-once, so duplicate delivery is possible and receivers should deduplicate by `eventId`.

## 1. Requirements and installation

The package is ESM and uses the runtime `fetch` API. Use a Node release that provides global `fetch` (Node 18 or newer is the practical baseline).

```bash
npm install @vikasbaplawat1/pulse-sdk
```

The package includes its tracing dependencies. Prisma and BullMQ are optional peers; install the integration's application library when you enable it.


## 2. Initialize before application traffic

The API key is the only required initialization option and is **not** read automatically from an environment variable. Reading `PULSE_API_KEY` below is an application convention. The SDK uses the production SaaS endpoint by default; `baseUrl` or `SDK_BASE_URL` are optional overrides for local development, staging, or self-hosted deployments.

```ts
import { createSDK } from '@vikasbaplawat1/pulse-sdk'

await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  service: 'payments-api',
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.GIT_SHA ?? 'local',
})
```

`createSDK(options)` is the recommended name and is equivalent to `init(options)`. Both resolve to the validated legacy `RemoteConfig` when initialization succeeds, or `undefined` when initialization cannot establish a usable runtime. Initialization retries retryable legacy-init failures and otherwise degrades without throwing into the host process. Calls with the same API-key identity share initialization state.

### Application package metadata precedence

At initialization the SDK resolves the consuming application's package once:

- `applicationName`: explicit `applicationName` → discovered `package.json.name` → `service` → `unknown-application`.
- `applicationVersion`: explicit `applicationVersion` → discovered `package.json.version` → `release` → `0.0.0-unknown`.
- `service`: explicit `service` → resolved application name.
- `release`: explicit `release` → resolved application version.
- `environment`: explicit `environment` → `production`.

Without `packageJsonPath`, discovery walks upward from `process.cwd()` to the first readable `package.json`. A relative `packageJsonPath` is resolved from `process.cwd()`. These values become authoritative event metadata; the pipeline reapplies them after processors and `beforeSend`.

```ts
import { createSDK } from '@vikasbaplawat1/pulse-sdk'

await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  packageJsonPath: './package.json',
  applicationName: 'checkout-worker',
  applicationVersion: '2.7.4',
  service: 'checkout',
  release: '2025-03-08.1',
})
```

### Initialization options

| Option | Behavior |
|---|---|
| `apiKey` | Required non-empty credential; sent as a bearer token after header validation. |
| `baseUrl` | Optional API origin override for local development, staging, or self-hosted deployments; defaults to the production SaaS endpoint. |
| `configUrl` | Optional remote-config URL override. |
| `service`, `environment`, `release` | Runtime identity; environment defaults to `production`. |
| `applicationName`, `applicationVersion`, `packageJsonPath` | Consuming-package identity and discovery controls. |
| `enableErrors`, `enablePerformance`, `enableTracing`, `enableMetrics` | Local convenience overrides merged with backend configuration and plan limits. |
| `sampleRate` | Legacy rate override in `[0, 1]`; v3 per-family rates come from remote config. |
| `maxBreadcrumbs` | Local breadcrumb cap, `0..1000`. |
| `plugins`, `eventProcessors`, `beforeBreadcrumb`, `beforeSend` | Extension hooks described below. |
| `transport` | Legacy batch, interval, retry, timeout, compression, payload, and concurrent-send overrides. Current multi-route transport is ultimately remote-config driven. |
| `debug`, `logLevel` | SDK diagnostics. Levels are `debug`, `info`, `warning`, `error`, `fatal`. |
| `shutdownTimeoutMs` | Graceful-shutdown deadline, `1000..60000` ms. |
| `sourceMaps` | Local search `paths`, `allowRemote`, and `embedSourceContent`. Remote maps are off unless explicitly allowed. |
| `dataScrubbing` | Adds sensitive headers/keys and request/response body redaction overrides. |
| `otelMetrics` | Histogram bucket, percentile, and cardinality bounds. |

Use `getConfig()` only after successful initialization; it throws if no resolved configuration exists. `getSDKHealth()` is safe before initialization and reports a degraded snapshot.

```ts
import { getConfig, getSDKHealth } from '@vikasbaplawat1/pulse-sdk'

console.log(getConfig().service)
console.log(getSDKHealth())
```

## 3. Capture APIs

All capture helpers are fail-open with respect to application control flow: internal failures are logged or converted to a no-op. Remote gates, sampling, rate limits, pressure controls, bounded queues, and transport state can still reject or drop telemetry.

### Errors

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

Signature: `captureError(error, options?)`, where options contain `context`, `severity`, `fingerprint`, and `mechanism`. For compatibility, a plain record without any option keys is treated directly as context. The helper parses the stack, computes a grouping fingerprint, correlates the active trace/span and breadcrumbs, and marks an active span as errored. Error killswitches and deterministic error sampling apply.

### Messages

```ts
import { captureMessage } from '@vikasbaplawat1/pulse-sdk'

captureMessage('Inventory is below reorder threshold', 'warning', {
  sku: 'sku_123',
  remaining: 4,
})
```

Signature: `captureMessage(message, severity = 'info', context?)`. Messages route with errors but remain a distinct `message` event type.

### Requests

Framework middleware is preferred, but a complete request event can be submitted manually:

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
  route: '/orders/:id',
})
```

`captureRequest(event)` adds the active trace/span IDs when the caller did not provide them. The caller must provide the required `RequestEvent` fields.

### Universal event capture and receipts

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

`accepted` means the event entered the local pipeline. `processed` resolves when asynchronous pipeline processing finishes. Neither means that the backend acknowledged delivery. `captureEvent()` accepts one of the ten documented `SDKEvent` shapes; unknown custom `type` values are not routable by the current transport. See [EVENT_TYPES.md](docs/EVENT_TYPES.md).

## 4. Logs, metrics, profiles, replay, and cron

### Structured logs

```ts
import { captureLog } from '@vikasbaplawat1/pulse-sdk'

captureLog('info', 'payment authorized', { paymentId: 'pay_123', amount: 4200 })
captureLog('warn', 'gateway latency high', { latencyMs: 850 })
```

Accepted levels are `debug`, `info`, `warning`, `warn`, `error`, `fatal`, and `log`. `warn` normalizes to `warning`; `log` normalizes to `info`. Up to ten arguments are retained by the logging subsystem and privacy scrubbing runs before transport. Calls are no-ops when logging is not entitled, not initialized, or disabled.

### Metrics

```ts
import {
  captureMetric,
  incrementCounter,
  setGauge,
  recordHistogram,
  addUpDownCounter,
} from '@vikasbaplawat1/pulse-sdk'

captureMetric('checkout.total', 1, 'counter', { tags: { region: 'us-east' } })
incrementCounter('orders.created', 1, { channel: 'web' })
setGauge('queue.depth', 42, { queue: 'billing' })
recordHistogram('http.server.duration', 37.5, { route: '/orders' }, 'ms')
addUpDownCounter('workers.active', -1, { pool: 'default' })
```

Metric admission checks the `customMetrics` entitlement, metrics killswitch, deterministic metric sampling, and registry cardinality/resource controls. Counters, gauges, histograms, and up-down counters aggregate in the registry before metric events are emitted. The public `captureMetric` types are `counter`, `gauge`, and `histogram`.

### CPU profiles

```ts
import { startProfile, stopProfile } from '@vikasbaplawat1/pulse-sdk'

const started = await startProfile('month-end-close')
try {
  await runMonthEndClose()
} finally {
  if (started) await stopProfile('month-end-close')
}
```

`startProfile(profileId)` returns `false` when profiling is disabled, not initialized, not entitled, or sampled out. `stopProfile(profileId)` is a safe no-op when no profiling subsystem is available. Trace-root profiling can also be activated by remote configuration.

### Replay segments

```ts
import { captureReplay } from '@vikasbaplawat1/pulse-sdk'

captureReplay('session_123', 0, [
  { kind: 'navigation', path: '/checkout', at: Date.now() },
])
```

`captureReplay(sessionId, segmentId, events)` rejects an empty session ID or empty event array and applies deterministic sampling by session. The API submits caller-provided replay entries; this Node SDK does not claim browser DOM recording.

### Cron check-ins

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

Statuses are `in_progress`, `ok`, and `error`; options are `duration` in milliseconds and an environment override. Post-init `in_progress` check-ins are tracked for a five-minute timeout and can produce an error check-in. Pre-init check-ins are buffered, but timeout tracking starts only when the cron subsystem exists. Cron batches intentionally use size one and zero wait time.

## 5. HTTP and framework instrumentation

Initialization registers configured auto-instrumentations when tracing is enabled. Registration is idempotent and remote configuration is authoritative. Instrument SDK bootstrap before loading instrumented application modules when possible; already-loaded libraries may not be patchable by their instrumentation package.

### Express

```ts
import { monitorMiddleware } from '@vikasbaplawat1/pulse-sdk'

app.use(express.json())
app.use(monitorMiddleware({
  ignorePaths: ['/health', /^\/internal\//],
  ignoreMethods: ['OPTIONS'],
  captureHeaders: false,
  captureQuery: true,
  captureBody: false,
  maxBreadcrumbs: 100,
  trustedProxies: ['10.0.0.10'],
}))
```

Place `express.json()` first only if body capture is intended; non-object strings and buffers contribute size but not body content. Forwarded client-IP headers are trusted only when the immediate peer matches `trustedProxies` (or `*`, which is safe only behind a locked-down proxy). Middleware captures completion and `next(error)` paths and establishes request context.

### Fastify

```ts
import { fastifyPulsePlugin } from '@vikasbaplawat1/pulse-sdk'

await fastify.register(fastifyPulsePlugin, {
  ignorePaths: ['/health'],
  ignoreMethods: ['OPTIONS'],
  captureHeaders: false,
  captureQuery: true,
  captureBody: false,
  maxBreadcrumbs: 100,
  trustedProxies: ['10.0.0.10'],
})
```

The Fastify plugin installs `onRequest`, `preHandler`, `onResponse`, and `onError` hooks. Fastify's own trusted-proxy-derived `request.ip` takes precedence when present.

### Node HTTP, HTTPS, and fetch

The auto-instrumentation set includes Node HTTP/HTTPS and Undici/fetch when remote config enables `instrumentation.http`, `instrumentation.https`, and `instrumentation.fetch`. Internal SDK endpoints are excluded and SDK sends suppress tracing to prevent export recursion. HTTP tracing produces spans; discrete `request` events come from Express/Fastify middleware or explicit `captureRequest()`.

`registerAutoInstrumentations(options?)` is public and accepts `http`, `express`, `fastify`, `undici`, `graphql`, `prisma`, `mongodb`, `redis`, `bullmq`, `axios`, `pg`, `mysql2`, and `eventEmitterPatch`. In normal use, let `createSDK()` call it after remote config is available. A second registration without shutdown/reset is a no-op.

### Optional integrations

Remote instrumentation flags select integrations and privacy capture settings constrain query/body/response detail. The root module also exports factory functions for custom wiring:

| Integration | Root factory | Important options |
|---|---|---|
| GraphQL | `createGraphQLInstrumentation(config, options?)` | `enabled`, `captureResolvers`, `depthLimit`/`maxDepth` |
| Prisma | `createPrismaInstrumentation(config, options?)` | Constructor exists; current standalone wrapper returns the upstream instrumentation, while richer query filtering is applied by auto-registration. |
| MongoDB | `createMongoDBInstrumentation(enabled, options?, capture?)` | Enhanced reporting and statement serializer; body capture defaults off. |
| Redis | `createRedisInstrumentation(enabled, options?, capture?)` | Statement serializer and response hook; sensitive commands are redacted. |
| BullMQ | `createBullMQInstrumentation(enabled, options?, capture?)` | Job/event capture and maximum job-data size. Auto-registration additionally supports bulk/flow span controls. |
| Axios | `createAxiosInstrumentation(enabled, options?, capture?)` | Returns `{ setup, teardown }`; may add Axios-specific spans in addition to Node HTTP spans. |
| PostgreSQL | `createPgInstrumentation(enabled, options?, capture?)` | Query reporting is off unless enabled by options/privacy. |
| MySQL2 | `createMySQLInstrumentation(enabled, options?, capture?)` | Statements are masked unless query capture is enabled. |

These factories return instrumentation objects; they do not all self-register. Prefer `registerAutoInstrumentations()` unless integrating with an existing instrumentation registration lifecycle.

## 6. Tracing

### Active custom spans

`withSpan()` is the preferred custom-span API because it activates the span across asynchronous work, records thrown errors, rethrows the original error, and ends the span automatically.

```ts
import { withSpan } from '@vikasbaplawat1/pulse-sdk'

const result = await withSpan('checkout.authorize', async span => {
  span.setAttributes({
    'checkout.order_id': 'order_123',
    'checkout.gateway': 'primary',
  })
  span.addEvent('authorization.started')
  return authorizePayment()
}, { timeoutMs: 5_000 })
```

A timeout ends and marks the span but does not cancel application work. `withSpanSync()` provides equivalent ownership for synchronous callbacks.

### Manually owned spans, attributes, events, errors, and links

```ts
import { startSpan } from '@vikasbaplawat1/pulse-sdk'

const span = startSpan('queue.consume', {
  attributes: { 'messaging.queue': 'billing' },
  links: [{
    traceId: upstreamTraceId,
    spanId: upstreamSpanId,
    attributes: { relationship: 'batch-item' },
  }],
})

try {
  await consumeJob()
  span.addEvent('job.complete').setStatus('ok')
} catch (error) {
  span.recordError(error as Error)
  throw error
} finally {
  span.end()
}
```

`startSpan()` does **not** make its span active. Auto-instrumented work started afterward will not automatically become its child. Use `withSpan()` for active-parent semantics. `end()` is idempotent. Additional methods include `setAttribute`, `setAttributes`, `addEvent`, `addLink(s)`, `recordException`, `updateName`, `spanContext`, `isRecording`, and `getOTelSpan`.

`getActiveSpan()`, `getTraceId()`, and `getSpanId()` expose current correlation, while `flushTracer()` force-flushes finished spans into the SDK pipeline.

### Manual header propagation

```ts
import { injectTraceContext, extractTraceContext, withSpan } from '@vikasbaplawat1/pulse-sdk'

await withSpan('publish.invoice', async () => {
  const headers: Record<string, string> = {}
  injectTraceContext(headers)
  await publishInvoice({ headers })
})

const extractedContext = extractTraceContext(incomingHeaders)
```

Injection adds W3C propagation headers and Pulse correlation headers when an active span exists. Extraction returns an OpenTelemetry `Context`; built-in HTTP/framework instrumentation handles activation automatically. Advanced custom activation requires an OpenTelemetry context lifecycle supplied by the host.

## 7. Scope, request context, and breadcrumbs

Scope enriches subsequent events with user, tags, extras, and named contexts.

```ts
import {
  setUser,
  setTags,
  setExtra,
  setContext,
  withScope,
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
```

Use `removeTag`, `removeExtra`, `setUser(null)`, `setContext(name, null)`, or `clearScope()` to remove state. `getScopeData()` returns a snapshot. `withScope()` clones the active scope and propagates the clone through the OpenTelemetry context; changes do not modify the parent scope.

Framework middleware creates request-local `ContextStore` data. For custom async boundaries:

```ts
import {
  createContextStore,
  withContext,
  bindContext,
  addBreadcrumb,
  getRequestContext,
} from '@vikasbaplawat1/pulse-sdk'

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
  const callback = bindContext(() => console.log(getRequestContext()?.requestId))
  queueMicrotask(callback)
})
```

Breadcrumbs are bounded by a ring buffer and attach to error/message events in context. `addBreadcrumb()` is a no-op outside a request `ContextStore`; the global SDK breadcrumb buffer is not the public mutation target here.

## 8. Plugins, processors, and hooks

Execution order is plugin `processEvent` in registration order, user `eventProcessors`, user `beforeSend`, then plugin `beforeSend`. Returning `null` drops the event. Per-hook timeouts prevent an extension from indefinitely blocking a pipeline task; thrown errors are logged and the pipeline continues.

```ts
import { createSDK } from '@vikasbaplawat1/pulse-sdk'
import type { SDKPlugin } from '@vikasbaplawat1/pulse-sdk'

const plugin: SDKPlugin = {
  meta: { name: 'deployment-tags', version: '1.0.0' },
  setup(context) {
    console.log('Pulse service:', context.metadata.service)
  },
  processEvent(event) {
    return { ...event, deploymentRing: 'canary' } as typeof event
  },
  processBreadcrumb(breadcrumb) {
    return breadcrumb.category === 'noise' ? null : breadcrumb
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
  eventProcessors: [event => event],
  beforeBreadcrumb: breadcrumb => breadcrumb,
  beforeSend: event => event,
})
```

Plugin names must be unique. Plugins may also implement `beforeFlush` and `onTransportError`; invocation depends on the active transport path. Do not put secrets in extension-generated fields. Authoritative SDK/application metadata is restored after these hooks.

## 9. Sampling, remote configuration, entitlements, and killswitches

Remote config is schema-versioned and controls:

- feature subsystem construction;
- per-family deterministic sampling for traces, requests, errors, profiles, replays, and metrics;
- longest-prefix route sampling overrides;
- instrumentation selection;
- privacy capture, scrubbing, and PII masking;
- limits and tenant governance;
- route URLs, batching, queue overflow, retries, connection concurrency, and timeouts;
- refresh TTL/stale-while-revalidate behavior;
- entitlements and emergency killswitches.

Sampling uses a deterministic FNV-1a decision key. Route overrides apply by longest matching string prefix; a rate of zero drops that family for the route. Traces are sampled at root creation with parent-based inheritance. Non-trace helpers use their documented family-specific sampling path.

Entitlement denial is silent:

- `customSpans`: custom span APIs return non-recording spans.
- `customMetrics`: metric helpers drop calls.
- `profiling`: profile APIs return `false`/no-op.
- `logging`, `sessionReplay`, `crons`: corresponding capture helpers no-op.

Core error/message capture, scope, context, breadcrumbs, flush, and shutdown are not billing-entitlement gated, though feature flags, killswitches, sampling, or runtime pressure may still affect telemetry.

Killswitches are `disableSDK`, `disableTracing`, `disableMetrics`, `disableTransport`, `disableProfiling`, `disableErrors`, and `disableLogs`. They apply to new work and trigger registered subsystem teardown/startup. Do not rely on a disabled transport as a durable local queue: router rejection can drop events.

## 10. Flush and shutdown

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

- `flush()` drains deferred pipeline tasks, flushes all transport routes, then flushes persistence. It does not tear down the runtime.
- `shutdown(timeoutMs?)` is single-flight, rejects new captures, tears down subsystems, flushes tracing/pipeline/transport, persists residuals, and resets globals. It never throws and returns a `ShutdownResult`. If the public deadline wins, exclusive cleanup continues in the background.
- `crashFlush(timeoutMs = 2000)` races a pipeline/transport drain against a hard timeout, swallows errors, and does not run plugin/subsystem teardown or persistence flush.

SIGTERM and SIGINT handlers are registered after successful initialization and initiate graceful shutdown, but application process-exit policy remains the application's responsibility. SIGKILL cannot be handled.

## 11. Privacy and security

Safe defaults disable header, body, response, query, and cookie capture until remote config enables them. Scrubbing defaults redact common authorization, cookie, API-key, password, OAuth token/code, national identifier, and payment fields; optional PII detection masks email, phone, and IP patterns. Payloads are scrubbed again at the transport boundary.

Operational guidance:

1. Keep body, response, query, and header capture off unless required.
2. Add organization-specific secrets through `dataScrubbing.sensitiveHeaders` and `sensitiveKeys`.
3. Never place credentials in span names, metric names/tags, route names, or monitor slugs.
4. Configure `trustedProxies` narrowly; never trust forwarded IP headers from arbitrary clients.
5. Keep `sourceMaps.allowRemote` false unless remote retrieval is required and reviewed.
6. Protect the host's cache directory: fallback persistence contains failed telemetry and file creation currently follows OS permissions/umask rather than declaring a private mode in the storage API.
7. Restrict API keys and do not log them. Transport uses `redirect: 'manual'` so bearer credentials are not followed to redirected origins.
8. Treat `beforeSend` as a final filter, not the only privacy control. Hook failures fail open to continued processing.

## 12. Troubleshooting

**No events arrive.** Confirm `createSDK()` completed, the API key is correct, any optional `baseUrl`/`SDK_BASE_URL` override is correct, remote routes are configured, the relevant feature and entitlement are enabled, and no killswitch is active. Inspect `getSDKHealth().circuitState`, queue drops, and SDK debug logs.

**`getConfig()` throws.** Initialization did not establish a resolved client config. Use `getSDKHealth()` before calling `getConfig()`.

**Spans are missing or disconnected.** Initialize before loading instrumented libraries; prefer `withSpan()` over `startSpan()` when child work needs an active parent. Ensure tracing and the relevant integration are enabled. Existing global OpenTelemetry setup is reused rather than replaced.

**Requests lack bodies/headers.** Privacy capture defaults are off. Enable them remotely or with middleware overrides only after reviewing data exposure. Express must parse JSON before middleware for object-body capture.

**Optional APIs silently do nothing.** This is expected when entitlements are explicitly false or the associated feature/subsystem is disabled. Profiles and logs also require completed SDK initialization.

**Flush or shutdown returns before all sends succeed.** Flushes are bounded and best-effort; route circuit state, retries, queue overflow, process termination, and filesystem/network failures can leave residual or dropped telemetry. Inspect `ShutdownResult` and health counters.

**Duplicates appear.** Failed events and shutdown residuals can be replayed. A response lost after backend acceptance also causes retry. Deduplicate by stable `eventId`; the SDK does not guarantee exactly-once delivery.

**High overhead.** Reduce sampling, disable unneeded instrumentation and payload capture, lower metric cardinality, and monitor pending/transport queues. The pipeline schedules one `setImmediate` per accepted event, and JSON serialization still occurs in-process even though gzip itself uses asynchronous zlib.
