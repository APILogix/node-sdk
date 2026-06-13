# Pulse SDK — Event Types Reference

> Source-of-truth for every event the Pulse Node SDK can emit.
> All facts here were extracted directly from `sdk-node/src/`.
> Schemas mirror the discriminated union in `src/types/event.ts`.

---

## Table of contents

1. [How events flow](#how-events-flow)
2. [Common base fields](#common-base-fields-attached-to-every-event)
3. [Route & batching matrix](#route--batching-matrix)
4. [Event types](#event-types)
   - [`error`](#1-errorevent--type-error)
   - [`message`](#2-messageevent--type-message)
   - [`request`](#3-requestevent--type-request)
   - [`span`](#4-spanevent--type-span)
   - [`trace`](#5-traceevent--type-trace)
   - [`metric`](#6-metricevent--type-metric)
   - [`log`](#7-logevent--type-log)
   - [`profile`](#8-profileevent--type-profile)
   - [`cron_checkin`](#9-croncheckinevent--type-cron_checkin)
   - [`replay`](#10-replayevent--type-replay)
5. [Auxiliary structures](#auxiliary-structures)
6. [Quick reference table](#quick-reference-table)

---

## How events flow

Every captured event flows through a single deferred async pipeline (`src/core/event-pipeline.ts`). Synchronous capture functions return immediately; processing is scheduled via `setImmediate`.

```
captureXxx()
  └─► captureEvent()                (src/capture/captureEvent.ts)
        └─► enqueueEvent()           (src/core/event-pipeline.ts)
              ├── Gate 1   sdk_shutting_down
              ├── Gate 1.1 pipeline_draining
              ├── Gate 1.5 KillswitchEngine.isSDKDisabled()
              ├── Gate 1.6 LimitsEngine.admitEvent()
              ├── Gate 2   critical memory pressure
              ├── Gate 3   loadShedder.shouldShed()
              └── Gate 4   pre-init buffering
              [setImmediate]
              └─► processEventAsync()
                    ├── ensureBaseFields            (eventId + timestamp)
                    ├── isFeatureEnabled            (FeatureController + plan)
                    ├── LimitsEngine.enforceAttributeLimits
                    ├── normalizeEvent              (truncate, default metadata)
                    ├── enrichFromContext           (traceId/spanId/requestId/breadcrumbs/sessionId)
                    ├── errorDeduplicator           (errors only)
                    ├── applyScopeToEvent           (user, tags, extra, contexts)
                    ├── attachSourceContext         (errors only)
                    ├── plugin.processEvent         (per plugin, 50 ms timeout)
                    ├── client.eventProcessors      (per processor, 50 ms timeout)
                    ├── beforeSend                  (user hook, 100 ms timeout)
                    ├── plugin.beforeSend           (per plugin, 100 ms timeout)
                    └── TransportRouter.send()      (route per event.type)
```

The router (`src/transport/transport-router.ts`) dispatches each event to its dedicated route based on the map in `src/transport/route-registry.ts`.

---

## Common base fields (attached to every event)

These are added by `normalizeEvent` and `enrichFromContext` even if the caller did not supply them.

| Field | Type | How it gets there |
|---|---|---|
| `eventId` | `string` | `generateId()` (UUID-v4) when missing |
| `timestamp` | `number` (epoch ms) | `epochMs()` when missing |
| `metadata` | `EventMetadata` | `{ sdkName, sdkVersion, service, environment, release, serverName? }` |
| `traceId` | `string?` | From OTel active span via `getTraceId()` |
| `spanId` | `string?` | From OTel active span via `getSpanId()` |
| `requestId` | `string?` | From `ContextStore` via `getRequestContext()` |
| `sessionId` | `string?` | From `SessionManager` (only if `sessionReplay` feature is on) |
| `breadcrumbs` | `Breadcrumb[]?` | Attached only to `error` and `message` events |
| `user`, `tags`, `extra`, `contexts` | varies | From `applyScopeToEvent()` |

---

## Route & batching matrix

Defined in `src/transport/transport-router.ts` (`QUEUE_CONFIG`, `BATCH_CONFIG`, `CONNECTION_LIMITS`) and `src/transport/route-registry.ts`.

| Event `type` | Route | Endpoint | Max batch | Wait | Min batch | Queue cap | Priority | Conn cap |
|---|---|---|---|---|---|---|---|---|
| `error` | `errors` | `POST /v1/errors` | 100 | 1 s | 1 | 10 000 | high | 30 |
| `message` | `errors` | `POST /v1/errors` | 100 | 1 s | 1 | 10 000 | high | 30 |
| `request` | `requests` | `POST /v1/requests` | 500 | 5 s | 10 | 50 000 | normal | 50 |
| `span` | `traces` | `POST /v1/traces` | 500 | 5 s | 10 | 50 000 | normal | 50 |
| `trace` | `traces` | `POST /v1/traces` | 500 | 5 s | 10 | 50 000 | normal | 50 |
| `metric` | `metrics` | `POST /v1/metrics` | 1 000 | 10 s | 50 | 25 000 | low | 20 |
| `log` | `logs` | `POST /v1/logs` | 200 | 10 s | 10 | 25 000 | normal | 20 |
| `profile` | `profiles` | `POST /v1/profiles` | 5 | 30 s | 1 | 5 000 | low | 5 |
| `cron_checkin` | `crons` | `POST /v1/checkins` | 1 | 0 ms (immediate) | 1 | 1 000 | high | 5 |
| `replay` | `replays` | `POST /v1/replays` | 5 | 10 s | 1 | 5 000 | low | 10 |

Max payload per request: **5 MB** (`MAX_PAYLOAD_BYTES`).

---


## Event types

---

### 1. `ErrorEvent` — `type: 'error'`

**Definition:** `src/types/event.ts`
**Primary generator:** `src/capture/captureError.ts → captureError()`

#### What generates it

| Source | File | Trigger |
|---|---|---|
| Public API | `captureError(err, options?)` | User code captures an exception |
| `uncaughtException` | `src/instrumentation/global-errors.ts` | Process emits an uncaught exception. Adds `mechanism: 'uncaughtException'`. Triggers `crashFlush()`. |
| `unhandledRejection` | `src/instrumentation/global-errors.ts` | Process emits an unhandled promise rejection. Adds `mechanism: 'unhandledRejection'`. |
| Wrapped `console.error` | `src/instrumentation/global-errors.ts` | Set `ERROR_DEFAULTS.captureConsoleErrors = true`. Adds `mechanism: 'console.error'`. |
| Express middleware | `src/instrumentation/express.ts` | `res.error` listener inside `monitorMiddleware`. |
| Fastify plugin | `src/instrumentation/fastify.ts` | `onError` hook. |

OTel filter: errors flagged as `isOtelInstrumentationError(err)` (socket-destroyed-before-response) are **suppressed** — they are non-fatal lifecycle artefacts of the OTel HTTP instrumentation, not application errors.

#### Schema

```ts
interface ErrorEvent {
  type:        'error'
  eventId?:    string
  requestId?:  string
  message:     string                          // truncated to 2 048 chars by normalizer
  name:        string                          // truncated to 256 chars
  stack:       readonly StackFrame[]           // see "StackFrame" below
  fingerprint: string                          // SHA-256 (see Fingerprinting)
  timestamp:   number                          // epoch ms
  severity:    'debug'|'info'|'warning'|'error'|'fatal'
  context:     Readonly<Record<string, unknown>>
  breadcrumbs?: readonly Breadcrumb[]          // attached automatically
  traceId?:    string
  spanId?:     string
  metadata?:   EventMetadata
}

// StackFrame (src/types/event.ts)
interface StackFrame {
  filename:  string
  function:  string
  lineno?:   number
  colno?:    number
  inApp:     boolean                            // true when filename isn't in node_modules / node:
  module?:   string
  sourceContext?: { pre: string[]; line: string; post: string[] }   // 5 lines pre/post
}
```

#### Generation pipeline (`captureError`)

1. **Killswitch gate** — `KillswitchEngine.isKilled('disableErrors')`.
2. **Sampling gate** — `SamplingEngine.shouldSampleError(message)`.
3. `toError()` normalises any input into a real `Error`.
4. If an active OTel span exists: `span.recordException()` + `span.setStatus(ERROR)`.
5. `parseStack()` — V8 `CallSite` API, regex fallback.
6. Path normalisation when `ERROR_DEFAULTS.grouping.normalizePaths` (strip absolute prefixes).
7. `generateFingerprint()` — SHA-256 of `name + in-app frames + normalized message`.
8. Attach breadcrumbs from `getRequestContext().breadcrumbs.toArray()`.
9. `captureEvent(event)` → pipeline.
10. Pipeline runs **error deduplication** by composite key `${fingerprint}:${service}:${release}:${tenantId}:${route}`.

#### Transport

`errors` route → `POST /v1/errors`, batch ≤ 100, wait 1 s.

---

### 2. `MessageEvent` — `type: 'message'`

**Definition:** `src/types/event.ts`
**Generator:** `src/capture/captureMessage.ts → captureMessage()`

#### What generates it

Public API only:

```ts
captureMessage('user signed up', 'info', { userId: '123' })
```

Severity defaults to `'info'`. Always allowed by `isFeatureEnabled` (no killswitch gate).

#### Schema

```ts
interface MessageEvent {
  type:         'message'
  eventId?:     string
  message:      string                           // truncated to 2 048 chars
  severity:     'debug'|'info'|'warning'|'error'|'fatal'
  timestamp:    number
  context?:     Readonly<Record<string, unknown>>
  breadcrumbs?: readonly Breadcrumb[]            // auto-attached
  traceId?:     string
  spanId?:      string
  metadata?:    EventMetadata
}
```

#### Transport

`errors` route → `POST /v1/errors`, batch ≤ 100, wait 1 s.

---

### 3. `RequestEvent` — `type: 'request'`

**Definition:** `src/types/event.ts`
**Wrapper:** `src/capture/captureRequest.ts → captureRequest()` (auto-enriches `traceId`/`spanId` from active OTel span)

#### What generates it

| Source | File | Hook |
|---|---|---|
| Express | `src/instrumentation/express.ts` | `res.once('finish' | 'close')` inside `monitorMiddleware` |
| Fastify | `src/instrumentation/fastify.ts` | `onResponse` hook in `fastifyPulsePlugin` |

Both pass through `evaluateCaptureGate()`:
- `KillswitchEngine.isKilled('disableTracing')` → drop.
- `FeatureController.isEnabled('requestCapture')` → must be true.
- `tenantGovernor.admitRequest(tenantId)` → must allow.
- `SamplingEngine.shouldSampleRequest({ path, method, sampleKey })` → samples.
- Local `ignorePaths` / `ignoreMethods` short-circuit before any work.

#### Schema

```ts
interface RequestEvent {
  type:        'request'
  eventId?:    string
  requestId:   string                  // x-request-id ← x-correlation-id ← generateId()
  url:         string                  // normalised route (req.route.path or req.path)
  method:      string                  // upper-cased by normalizer
  statusCode:  number
  latency:     number                  // Date.now() - startTime
  timestamp:   number                  // request start time
  headers?:    Record<string, unknown> // present iff privacy.capture.headers === true; scrubbed
  query?:      Record<string, unknown> // present iff privacy.capture.query === true; scrubbed
  body?:       Record<string, unknown> // present iff privacy.capture.body === true; truncated > 64 KB
  bodySize?:   number
  responseSize?: number                // from response 'content-length'
  userId?:     string | null           // req.user.id ← req.user.userId
  tenantId?:   string                  // x-tenant-id
  sessionId?:  string                  // x-session-id
  clientIp?:   string                  // x-forwarded-for[0] / x-real-ip / socket.remoteAddress
  userAgent?:  string
  referer?:    string
  route?:      string
  traceId?:    string                  // active OTel span
  spanId?:     string                  // active OTel span
  metadata?:   EventMetadata
}
```

The middleware also writes Pulse-specific attributes onto the active span: `pulse.request_id`, `pulse.tenant_id`, `pulse.user_id`, `pulse.session_id`, `pulse.latency_ms`, `pulse.framework` (`express` / `fastify`), `pulse.fallback_root` when no OTel HTTP instrumentation is registered.

#### Transport

`requests` route → `POST /v1/requests`, batch ≤ 500, wait 5 s.

---

### 4. `SpanEvent` — `type: 'span'`

**Definition:** `src/types/event.ts`
**Generator:** `src/tracing/tracer.ts → PipelineSpanExporter.spanToEvent()`

The exporter is plugged into a `BatchSpanProcessor` on the OTel `NodeTracerProvider`. Every span — manual or auto-instrumented — flows through it.

#### What generates spans

| Source | Span name | Notes |
|---|---|---|
| `startSpan(name, opts?)` | as supplied | Manual span. |
| `withSpan(name, fn, opts?)` | as supplied | Async-safe wrapper. Adds `pulse.span.timeout` event on timeout. |
| `withSpanSync(name, fn, opts?)` | as supplied | Sync variant. |
| `HttpInstrumentation` | `HTTP <METHOD>` / `<METHOD> <route>` | Built-in (auto-registered). Filters internal `x-pulse-internal` and ingest paths. |
| `UndiciInstrumentation` | `HTTP <METHOD>` | `fetch` / undici client calls. |
| `ExpressInstrumentation` | `<route>` | Per route handler. |
| `FastifyInstrumentation` | `request handler - <route>` | Per route, hooks. |
| `MongoDBInstrumentation` | `<db>.<collection>.<op>` | DB attributes (see below). |
| Custom `pg` instrumentation | `pg.query` / `pg.connect` | `src/instrumentation/pg.ts`. |
| Custom `mysql2` instrumentation | `mysql2.query` | `src/instrumentation/mysql.ts`. |
| `RedisInstrumentation` | `<command>` | redis-4 client. Sensitive commands → `[REDACTED]`. |
| `PrismaInstrumentation` | `prisma:engine:<op>` | `@prisma/instrumentation`. |
| `GraphQLInstrumentation` | `graphql.execute`, `graphql.resolve` | Per-resolver only when `captureResolvers: true`. |
| `BullMQInstrumentation` | `<queue> <op>` | Job lifecycle spans. |
| Custom Axios shim | `HTTP <METHOD>` | `src/instrumentation/axios.ts`. |
| Express fallback root | `<METHOD> <path>` | When OTel HTTP instr is disabled. Tagged `pulse.fallback_root: true`. |

#### Schema

```ts
interface SpanEvent {
  type:               'span'
  eventId:            `span_${spanId}`
  spanId:             string
  traceId:            string
  parentSpanId?:      string
  name:               string
  kind?:              'internal'|'server'|'client'|'producer'|'consumer'
  startTime:          number
  endTime:            number
  duration:           number                              // ms
  exclusiveDuration?: number                              // self-time, computed by spanDurationTracker
  status:             'ok'|'error'|'unset'
  statusMessage?:     string
  attributes?:        Readonly<Record<string, unknown>>   // filtered (see below)
  events?:            { name, timestamp, attributes? }[]  // includes 'exception', 'pulse.profile.start/stop', 'pulse.span.timeout'
  links?:             { traceId, spanId, attributes? }[]
  metadata:           EventMetadata
  requestId?, sessionId?, userId?, tenantId?:             // pulled from PULSE_CONTEXT_ATTRIBUTES
  __pulseInternal:    true                                // stripped before sending
}
```

#### Attribute filtering (`spanToEvent`)

Driven by `privacy.capture.*` from remote config:

- `headers: false` → strip `http.request.header.*` and `http.response.header.*`.
- `body: false` → strip `http.request.body`, `http.response.body`.
- `cookies: false` → strip `http.request.header.cookie`, `http.request.header.set-cookie`.
- `response: false` → strip every `http.response.*` attribute.
- `limits.maxSpanAttributes` (default **100**) → truncate; adds `pulse.attributes_truncated: true` and `pulse.original_attribute_count: <n>`.

#### Common attributes per instrumentation

| Instrumentation | Notable attributes |
|---|---|
| HTTP / undici | `http.method`, `http.url`, `http.host`, `http.scheme`, `http.target`, `http.status_code`, `http.user_agent`, `http.referer`, `http.client_ip`, `http.route`, `http.request.body.size`, `http.response.body.size`, `pulse.http.socket_state`, `pulse.http.incomplete_response` |
| Axios | All HTTP attrs + `http.user_agent='axios'`, `http.status_text`, `http.axios.request_timeout`, `http.request.headers`, `http.request.query`, `http.response.headers`, `http.response.body`, `db.system='http'` |
| MongoDB | `db.system='mongodb'`, `db.name`, `db.mongodb.cluster`, `db.operation`, `db.collection`, `db.statement` |
| PostgreSQL | `db.system='postgresql'`, `db.name`, `db.operation`, `db.sql.table`, `db.statement` |
| MySQL | `db.system='mysql'`, `db.name`, `db.operation`, `db.sql.table`, `db.statement` |
| Redis | `db.system='redis'`, `db.redis.command`, `db.redis.command_args`, `db.redis.key`, `db.redis.database` |
| BullMQ | `messaging.system='bullmq'`, `messaging.destination`, `messaging.operation` (`process`/`add`/`remove`/`retry`), `messaging.bullmq.job.{id,name,attempts,timestamp}`, `messaging.bullmq.queue.name` |

#### Transport

`traces` route → `POST /v1/traces`, batch ≤ 500, wait 5 s.

---

### 5. `TraceEvent` — `type: 'trace'`

**Definition:** `src/types/event.ts`, `src/tracing/trace-aggregator.ts`
**Generator:** `TraceAggregator.flushTrace()`

#### What generates it

`PipelineSpanExporter.export()` simultaneously:
1. Sends each `SpanEvent` to the pipeline.
2. Calls `getTraceAggregator().addSpan(spanEvent)`.

The aggregator buffers spans by `traceId` and emits a `TraceEvent` when:

- The **root span** (no `parentSpanId`) arrives → `flushIfComplete()` at the end of the export batch.
- Orphan timeout fires (default **30 s**) → `isPartial: true`.
- Buffer overflow eviction (default cap **1 000** traces).
- `flushAll()` on shutdown.

#### Schema

```ts
interface TraceEvent {
  type:           'trace'
  eventId:        `trace_${traceId}`
  traceId:        string
  rootSpan:       AggregatedSpanEvent          // recursive (contains children[])
  spanCount:      number
  totalDuration:  number
  isPartial:      boolean                       // true when root never arrived
  metadata?:      EventMetadata
  requestId?, sessionId?, userId?, tenantId?:   // copied from root span
  __pulseInternal: true
}

interface AggregatedSpanEvent {
  spanId:           string
  parentSpanId?:    string
  name:             string
  kind?:            string
  startTime:        number
  endTime:          number
  duration:         number
  exclusiveDuration?: number
  status:           string
  statusMessage?:   string
  attributes?:      Record<string, unknown>
  events?:          { name, timestamp, attributes? }[]
  links?:           { traceId, spanId, attributes? }[]
  children:         AggregatedSpanEvent[]       // built by depth-first parentSpanId match
}
```

#### Transport

`traces` route → `POST /v1/traces`. Coexists with raw `span` events.

---

### 6. `MetricEvent` — `type: 'metric'`

**Definition:** `src/types/event.ts`
**Primary generator:** `src/metrics/pulse-metric-reader.ts → PulseMetricReader.collectAndExport()`

#### Two paths into the metric system

1. **Direct:** `captureMetric(name, value, type, options?)` (`src/capture/captureMetric.ts`).
   - For `counter`, `gauge`, `histogram` it routes the value into `metricsRegistry` (OTel) and **does not** emit a `MetricEvent` itself; aggregation happens inside the OTel `MeterProvider`.
   - Only "other" types fall through to `captureEvent()`.
2. **OTel reader:** `PulseMetricReader` extends `MetricReader` and runs on a fixed interval (10 s default) plus on `forceFlush`/`shutdown`. It iterates collected `MetricData` and emits one `MetricEvent` per data point via `processEvent`.

#### Convenience helpers (all route through `metricsRegistry`)

```ts
incrementCounter(name, value=1, tags?)
setGauge(name, value, tags?)
recordHistogram(name, value, tags?, unit?)
addUpDownCounter(name, value, tags?)
```

#### Schema (built by `dataPointToEvent`)

```ts
interface MetricEvent {
  type:        'metric'
  eventId:     string                   // generateId()
  metricName:  string
  metricType:  'counter' | 'gauge' | 'histogram'
  value:       number                   // point.avg
  unit?:       string                   // only when sourced from captureMetric with options.unit
  tags?:       Record<string, string>   // sanitised by cardinalityGovernor
  timestamp:   number
  metadata?:   EventMetadata
  count?:      number
  sum?:        number
  min?:        number
  max?:        number
  avg?:        number
  rate?:       number                   // currently always 0
  // Histograms only:
  buckets?:    {
    scale:           number
    offset:          number
    positiveCounts:  number[]
    negativeCounts?: number[]
    zeroCount:       number
  }
  // Declared but NOT populated by current reader:
  p50?, p75?, p90?, p95?, p99?: number
}
```

#### Data-point → metric type mapping

| OTel `DataPointType` | Emitted `metricType` |
|---|---|
| `SUM` | `counter` |
| `GAUGE` | `gauge` |
| `HISTOGRAM` | `histogram` |
| `EXPONENTIAL_HISTOGRAM` | `histogram` (+ `buckets` field) |

#### Transport

`metrics` route → `POST /v1/metrics`, batch ≤ 1 000, wait 10 s.

---

### 7. `LogEvent` — `type: 'log'`

**Definition:** `src/types/event.ts`
**Generator:** `src/subsystems/logging-subsystem.ts → LoggingSubsystem.captureLog()`

#### What generates it

| Source | Trigger | Notes |
|---|---|---|
| Console interception | `console.log/info/warn/error/debug` | Installed when `logging.enabled && logging.captureConsole`. `console.log` mapped to `'info'`. |
| Direct call | `LoggingSubsystem.captureLog(level, message, args)` | Internal API for plugin code. |

Filters by `logging.levels` (config). Truncates message to `logging.maxLogSize` (suffix `'… [truncated]'`). `args` slice to first 10 entries. Re-entry guard prevents recursion if SDK code itself calls `console.*` during capture.

#### Schema

```ts
interface LogEvent {
  type:       'log'
  eventId?:   string
  level:      string                  // 'debug'|'info'|'warn'|'error' (host string preserved; console.log → 'info')
  message:    string                  // post-truncation
  timestamp:  number
  args?:      readonly unknown[]      // first 10 raw args
  requestId?: string
  traceId?:   string
  spanId?:    string
  metadata?:  EventMetadata
}
```

#### Transport

`logs` route → `POST /v1/logs`, batch ≤ 200, wait 10 s.

---

### 8. `ProfileEvent` — `type: 'profile'`

**Definition:** `src/types/event.ts`
**Generator:** `src/subsystems/profiling-subsystem.ts → ProfilingSubsystem.stopCpuProfile()`

#### What generates it

| Source | Trigger |
|---|---|
| Auto on root span | `withSpan` / `withSpanSync` calls `startCpuProfile()` when the root span starts; stops in the matching `finally`. Probabilistic via FNV-1a hash of `traceId` against `profiling.sampleRate`. |
| Manual | `startProfile(profileId)` / `stopProfile(profileId)` (`src/capture/captureProfile.ts`) |

Implementation uses `node:inspector/promises` `Session`: `Profiler.enable` → `Profiler.start` → `Profiler.stop`. A timer (`maxDurationMs`) hard-caps a single profile.

When active, the owning span receives:
- event `pulse.profile.start` `{ profile.type, profile.id }`
- event `pulse.profile.stop` `{ profile.type, profile.duration_ms }`
- attribute `pulse.profile.active` (bool)

> The schema declares `profileType: 'cpu' | 'heap'`, but the current subsystem emits **only `cpu`**. Heap profiling is reserved.

#### Schema

```ts
interface ProfileEvent {
  type:        'profile'
  eventId?:    string
  profileType: 'cpu' | 'heap'         // currently only 'cpu' emitted
  requestId?:  string
  traceId?:    string
  spanId?:     string
  startTime:   number
  endTime:     number
  duration:    number
  profile:     unknown                 // raw V8 inspector Profiler.stop result
  timestamp:   number
  metadata?:   EventMetadata
}
```

#### Transport

`profiles` route → `POST /v1/profiles`, batch ≤ 5, wait 30 s.

---

### 9. `CronCheckInEvent` — `type: 'cron_checkin'`

**Definition:** `src/types/event.ts`
**Generator:** `src/subsystems/cron-subsystem.ts → CronSubsystem.checkIn()`

#### What generates it

| Source | Trigger |
|---|---|
| Public API | `captureCronCheckIn(monitorSlug, status, options?)` (`src/capture/captureCronCheckIn.ts`) |
| Auto timeout | When an `'in_progress'` monitor isn't completed within `DEFAULT_MONITOR_TIMEOUT_MS = 5 * 60 000` ms, the subsystem auto-emits a `status: 'error'` event with `duration: monitorTimeoutMs`. |

Tracks in-flight monitors (`Map<monitorSlug, InFlightMonitor>`) with `setTimeout` + `unref()`. Completing (`ok`/`error`) clears the timeout.

#### Schema

```ts
interface CronCheckInEvent {
  type:         'cron_checkin'
  eventId?:     string
  monitorSlug:  string
  status:       'ok' | 'error' | 'in_progress'
  timestamp:    number
  duration?:    number               // ms
  environment?: string               // defaults to metadata.environment
  metadata?:    EventMetadata
}
```

#### Transport

`crons` route → `POST /v1/checkins`, **immediate flush** (batch size 1, `maxWaitTimeMs: 0`).

---

### 10. `ReplayEvent` — `type: 'replay'`

**Definition:** `src/types/event.ts`
**Generator:** none in this Node SDK.

The type, route, feature gate (`FeatureController.isEnabled('sessionReplay')`), endpoint (`/v1/replays`), batching parameters, and queue capacity are all wired. The Node SDK reserves the schema; concrete `replay` events would be produced by a browser or replay agent and forwarded.

#### Schema

```ts
interface ReplayEvent {
  type:       'replay'
  eventId?:   string
  sessionId:  string
  segmentId:  number
  timestamp:  number
  events:     readonly unknown[]      // recorded DOM mutation events
  metadata?:  EventMetadata
}
```

#### Transport

`replays` route → `POST /v1/replays`, batch ≤ 5, wait 10 s.

---


## Auxiliary structures

These are not standalone events but are embedded inside events.

### `EventMetadata` (attached to every event)

`src/types/event.ts`

```ts
interface EventMetadata {
  sdkName:     string
  sdkVersion:  string
  service:     string
  environment: string
  release:     string
  serverName?: string
}
```

### `Breadcrumb`

`src/types/breadcrumb.ts`. Recorded via `addBreadcrumb()` (`src/core/context.ts`). Stored in a per-request `RingBuffer` and auto-attached to `error` and `message` events.

```ts
interface Breadcrumb {
  timestamp:  string                       // ISO 8601
  category:   string                       // e.g. 'http', 'navigation', 'console', 'query', 'ui'
  message?:   string
  level:      SeverityLevel
  type:       'default'|'http'|'navigation'|'error'|'query'|'ui'|'user'|'info'|'debug'
  data?:      Readonly<Record<string, unknown>>
}
```

### `Session` (not emitted, only attached as `sessionId`)

`src/session/session-manager.ts`. The `SessionManager` mints a UUID-v4 session id, tracks `startedAt`, `lastActivityAt`, `eventCount`, `errorCount`, `crashed`, `status`. Session ends after **30 min idle** or **4 h max duration**. The pipeline writes `sessionId` onto every event when `FeatureController.isEnabled('sessionReplay')` is true; it also calls `recordError()` on errors and `recordActivity()` on everything else.

### Scope additions

`src/core/scope.ts` `applyScopeToEvent()` may add:

- `user: { id, email?, username?, ipAddress?, data? }`
- `tags: Record<string, string>`
- `extra: Record<string, unknown>`
- `contexts: Record<string, Record<string, unknown>>`

### Severity levels

`src/types/severity.ts`

```
debug  <  info  <  warning  <  error  <  fatal
```

Aliases recognised by `severityFromString`: `trace→debug`, `log/information→info`, `warn→warning`, `err/exception→error`, `critical/panic→fatal`.

### Init handshake (NOT a telemetry event)

`src/transport/sender.ts → sendInitRequest()` posts `{ apiKey }` to `/v1/init` once at SDK startup to fetch remote config. This is configuration bootstrap, not an event emission.

---

## Quick reference table

| `type` | Generator (file → function) | Endpoint | Triggered by |
|---|---|---|---|
| `error` | `capture/captureError.ts → captureError()` ; `instrumentation/global-errors.ts` | `/v1/errors` | Manual capture, `uncaughtException`, `unhandledRejection`, wrapped `console.error`, Express `res.error`, Fastify `onError` |
| `message` | `capture/captureMessage.ts → captureMessage()` | `/v1/errors` | Manual capture |
| `request` | `capture/captureRequest.ts → captureRequest()` | `/v1/requests` | Express `monitorMiddleware` (`finish`/`close`), Fastify `fastifyPulsePlugin` (`onResponse`) |
| `span` | `tracing/tracer.ts → PipelineSpanExporter.spanToEvent()` | `/v1/traces` | Manual `startSpan`/`withSpan`/`withSpanSync`; auto: HTTP, undici, Express, Fastify, MongoDB, pg, mysql2, Redis, Prisma, GraphQL, BullMQ, Axios |
| `trace` | `tracing/trace-aggregator.ts → TraceAggregator.flushTrace()` | `/v1/traces` | Root span arrival, orphan timeout (30 s), buffer eviction, shutdown flush |
| `metric` | `metrics/pulse-metric-reader.ts → PulseMetricReader.collectAndExport()` | `/v1/metrics` | 10 s interval, `forceFlush`, `shutdown` (sources: `incrementCounter`, `setGauge`, `recordHistogram`, `addUpDownCounter`, `captureMetric`) |
| `log` | `subsystems/logging-subsystem.ts → LoggingSubsystem.captureLog()` | `/v1/logs` | Wrapped `console.log/info/warn/error/debug`, internal `captureLog` |
| `profile` | `subsystems/profiling-subsystem.ts → ProfilingSubsystem.stopCpuProfile()` | `/v1/profiles` | Auto on sampled root span, manual `startProfile`/`stopProfile` |
| `cron_checkin` | `subsystems/cron-subsystem.ts → CronSubsystem.checkIn()` | `/v1/checkins` | `captureCronCheckIn()`, auto-timeout after 5 min in `in_progress` |
| `replay` | (reserved — no Node emitter) | `/v1/replays` | n/a in this SDK |

---

## File index

| Concern | File |
|---|---|
| Event type definitions | `src/types/event.ts`, `src/types/breadcrumb.ts`, `src/types/severity.ts` |
| Capture entry points | `src/capture/captureEvent.ts`, `captureError.ts`, `captureMessage.ts`, `captureRequest.ts`, `captureMetric.ts`, `captureCronCheckIn.ts`, `captureProfile.ts` |
| Pipeline | `src/core/event-pipeline.ts` |
| Normalisation / sanitisation | `src/processors/normalizer.ts`, `sanitizer.ts`, `fingerprint.ts`, `stack-parser.ts`, `deduplicator.ts`, `source-context.ts` |
| Tracing | `src/tracing/tracer.ts`, `trace-aggregator.ts` |
| Metrics | `src/metrics/pulse-metric-reader.ts`, `registry.ts` |
| Subsystems | `src/subsystems/logging-subsystem.ts`, `profiling-subsystem.ts`, `cron-subsystem.ts` |
| Session | `src/session/session-manager.ts` |
| Auto-instrumentation | `src/instrumentation/auto-instrument.ts` and per-vendor files |
| Express / Fastify | `src/instrumentation/express.ts`, `fastify.ts` |
| Global error handlers | `src/instrumentation/global-errors.ts` |
| Transport | `src/transport/transport-router.ts`, `route-registry.ts`, `batch-manager.ts`, `connection-manager.ts`, `transport-event-queue.ts`, `sender.ts` |
