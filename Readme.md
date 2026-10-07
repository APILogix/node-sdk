# @pulse-apm/node

> Enterprise-grade observability and distributed tracing SDK for Node.js applications, built natively on OpenTelemetry with automated framework and database interception, truthful timing attribution, adaptive load shedding, resilient offline disk spooling, and detached background task tracing.

[![Version](https://img.shields.io/badge/version-8.5.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)]()
[![Type](https://img.shields.io/badge/module-ESM%20native-orange.svg)]()
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](package.json)

---

## Table of Contents

- [1. Overview & Architecture](#1-overview--architecture)
- [2. Requirements](#2-requirements)
- [3. Installation](#3-installation)
- [4. Quick Start](#4-quick-start)
  - [Minimal Node.js Example](#minimal-nodejs-example)
  - [Express.js Application](#expressjs-application)
  - [Fastify Application](#fastify-application)
- [5. Process Bootstrap & Zero-Code Preload](#5-process-bootstrap--zero-code-preload)
- [6. Initialization (`init`)](#6-initialization-init)
  - [Complete `init()` Options Reference](#complete-init-options-reference)
  - [Fail-Open Initialization & Recovery Behavior](#fail-open-initialization--recovery-behavior)
- [7. Remote Configuration Directives](#7-remote-configuration-directives)
- [8. Automatic Instrumentation](#8-automatic-instrumentation)
- [9. Complete API Reference by Domain](#9-complete-api-reference-by-domain)
  - [A. Lifecycle & Operational Health](#a-lifecycle--operational-health)
  - [B. Event & Exception Capture](#b-event--exception-capture)
  - [C. OpenTelemetry Metrics Instruments](#c-opentelemetry-metrics-instruments)
  - [D. Scope, Tags, User & Breadcrumbs](#d-scope-tags-user--breadcrumbs)
  - [E. Context & Distributed Trace Propagation](#e-context--distributed-trace-propagation)
  - [F. Tracing, Custom Spans & Database Queries](#f-tracing-custom-spans--database-queries)
  - [G. Framework & Middleware Instrumentation](#g-framework--middleware-instrumentation)
  - [H. Driver Instrumentation Factories & Helpers](#h-driver-instrumentation-factories--helpers)
  - [I. Diagnostic Logging & Error Classification](#i-diagnostic-logging--error-classification)
  - [J. Canonical `Pulse` Facade Object](#j-canonical-pulse-facade-object)
- [10. Express.js Deep Dive](#10-expressjs-deep-dive)
  - [Enabling Middleware Duration Profiling (`instrumentMiddleware: true`)](#enabling-middleware-duration-profiling-instrumentmiddleware-true)
- [11. Fastify Deep Dive](#11-fastify-deep-dive)
- [12. Database Instrumentation & Slow Query Tagging](#12-database-instrumentation--slow-query-tagging)
- [13. Detached Background Task Tracing (`withBackgroundSpan`)](#13-detached-background-task-tracing-withbackgroundspan)
- [14. Cron & Job Monitoring (`captureCronCheckIn`)](#14-cron--job-monitoring-capturecroncheckin)
- [15. Reliability, Delivery Semantics & Load Shedding](#15-reliability-delivery-semantics--load-shedding)
- [16. Privacy, PII Scrubbing & Security](#16-privacy-pii-scrubbing--security)
- [17. Graceful Shutdown & Kubernetes Lifecycle](#17-graceful-shutdown--kubernetes-lifecycle)
- [18. Production Best Practices](#18-production-best-practices)
- [19. Common Integration Mistakes](#19-common-integration-mistakes)
- [20. Troubleshooting Guide](#20-troubleshooting-guide)
- [21. Migration Guide (Legacy to Modern Function Names)](#21-migration-guide-legacy-to-modern-function-names)

---

## 1. Overview & Architecture

`@pulse-apm/node` is engineered with an absolute **fail-open design**: telemetry operations must never degrade, block, leak memory, or crash the host application under any conditions (network outages, invalid keys, rate limits, or memory pressure).

```
Host Application Code
        │
        ▼
[ Auto-Instrumentation / Manual Tracing ]
        │
        ├── Context Propagation (W3C traceparent / AsyncLocalStorage)
        ├── Scope Management (User identity, tags, breadcrumbs)
        │
        ▼
[ Canonical Event Normalization & PII Sanitization ]
        │  (RegEx URL redaction, header masks, JSON body scrubbing)
        │
        ▼
[ Deterministic Sampling Engine ]
        │  (Head-based FNV-1a trace sampling + route-specific overrides)
        │
        ▼
[ Transport Priority Event Queue ]
        │  ├── P0: Critical Fatal Crashes & Unhandled Exceptions
        │  ├── P1: Handled Exceptions & HTTP 5xx Server Errors
        │  ├── P2: Traces & HTTP Transactions
        │  └── P3: Low-Priority Steady-State Metrics & Breadcrumbs
        │
        ▼
[ Adaptive Load Shedder & Circuit Breakers ]
        │  (Drops P3 -> P2 -> P1 based on Event-Loop Lag & Heap limits)
        │
        ▼
[ Worker Thread Serialization Pool (Batches > 50KB) & Gzip Compression ]
        │
        ├── Network Route Senders (10 Dedicated Transport Routes)
        │       ├── /v1/errors
        │       ├── /v1/traces
        │       ├── /v1/requests
        │       ├── /v1/metrics
        │       ├── /v1/logs
        │       └── /v1/crons
        │
        └── Offline Disk Spooling Fallback (Persistent SQLite/File Queue on Outage)
```

---

## 2. Requirements

- **Node.js**: `>= 18.0.0` (Supports Node.js 18, 20, 22+)
- **Module System**: Dual ESM / CommonJS support
- **TypeScript**: `>= 5.0.0` (Type definitions bundled in `dist/index.d.ts`)

---

## 3. Installation

Install the package via your preferred package manager:

```bash
# npm
npm install @pulse-apm/node

# pnpm
pnpm add @pulse-apm/node

# yarn
yarn add @pulse-apm/node
```

---

## 4. Quick Start

### Minimal Node.js Example

```ts
import { init, captureException, captureMessage, flush } from '@pulse-apm/node'

// Initialize the SDK
await init({
  apiKey: process.env.PULSE_API_KEY!,
  applicationName: 'billing-service',
  environment: 'production',
})

try {
  captureMessage('Service initialized successfully', 'info')
  // Your business logic
} catch (error) {
  // Capture exception with automatic stack parsing and trace correlation
  captureException(error)
} finally {
  await flush()
}
```

### Express.js Application

In Express, mount **`pulseMiddleware`** at the top of your middleware stack and **`expressErrorHandler`** at the bottom:

```ts
import express from 'express'
import { init, pulseMiddleware, expressErrorHandler, captureException } from '@pulse-apm/node'

await init({
  apiKey: process.env.PULSE_API_KEY!,
  applicationName: 'order-api',
})

const app = express()

// 1. MUST BE FIRST MIDDLEWARE: Starts request trace, AsyncLocalStorage, and binds context
app.use(pulseMiddleware({
  ignorePaths: ['/health', '/metrics'],
  instrumentMiddleware: true, // Profiles middleware durations (e.g. auth, validation)
  minMiddlewareDurationMs: 2, // Only emit child spans for middlewares taking >= 2ms
}))

app.use(express.json())

// Application routes
app.get('/api/orders/:id', async (req, res) => {
  res.json({ id: req.params.id, status: 'confirmed' })
})

app.post('/api/checkout', async (req, res) => {
  try {
    // Process payment...
    res.json({ success: true })
  } catch (err) {
    captureException(err)
    res.status(500).json({ error: 'Checkout failed' })
  }
})

// 2. MUST BE LAST MIDDLEWARE: Captures unhandled route errors passed to next(err)
app.use(expressErrorHandler())

app.listen(3000, () => console.log('Server running on port 3000'))
```

### Fastify Application

```ts
import Fastify from 'fastify'
import { init, pulseFastifyPlugin } from '@pulse-apm/node'

await init({ apiKey: process.env.PULSE_API_KEY! })

const fastify = Fastify()

// Register the Pulse Fastify plugin
await fastify.register(pulseFastifyPlugin, {
  ignorePaths: ['/healthz'],
  captureHeaders: true,
})

fastify.get('/api/users/:id', async (request, reply) => {
  return { id: (request.params as any).id }
})

await fastify.listen({ port: 3000, host: '0.0.0.0' })
```

---

## 5. Process Bootstrap & Zero-Code Preload

To guarantee that auto-instrumentation intercepts Node.js core modules (`http`, `https`, `fetch`) and third-party drivers (`pg`, `mysql2`, `mongodb`, `redis`) before your application requires them, use Node's native `--import` flag:

```bash
# Node.js >= 18.19.0 (ESM & CJS)
node --import @pulse-apm/node/register dist/server.js

# Or in your package.json scripts:
{
  "scripts": {
    "start": "node --import @pulse-apm/node/register dist/server.js"
  }
}
```

When started with `--import @pulse-apm/node/register`, monkey-patching hooks are registered immediately at process startup. Your application code then simply calls `await init({ apiKey: ... })`.

---

## 6. Initialization (`init`)

The `init(options)` function establishes connection with the Pulse control plane, fetches the remote configuration snapshot (`POST /v1/init`), activates enabled subsystems, and sets up process shutdown hooks.

```ts
import { init } from '@pulse-apm/node'

const config = await init({
  apiKey: process.env.PULSE_API_KEY!,
  endpoint: 'https://ingest.pulse-apm.com',
  applicationName: 'payment-gateway',
  applicationVersion: '2.4.0',
  environment: 'production',
  debug: false,
})
```

### Complete `init()` Options Reference

The options object passed to `init()` is strictly validated using Zod. Passing unsupported keys triggers a validation error and places the SDK into dormant recovery mode.

| Parameter | Type | Required | Default | Description | Constraints |
|---|---|---|---|---|---|
| `apiKey` | `string` | **Yes** | — | Project API authentication token. | Non-empty; printable ASCII only. |
| `endpoint` | `string` | No | `'https://api.pulse.dev'` | Base ingestion server URL. | Must be valid HTTP/HTTPS URL. |
| `applicationName` | `string` | No | `'node-application'` | Service name for traces and metrics. | Max 128 characters. |
| `applicationVersion` | `string` | No | `'0.0.0'` | Release version (e.g. `'1.2.0'`). | Semantic version or Git SHA. |
| `environment` | `string` | No | `process.env.NODE_ENV` or `'production'` | Target environment (e.g. `'production'`, `'staging'`). | Max 64 characters. |
| `debug` | `boolean` | No | `false` | Enables verbose diagnostic console logging. | Boolean. |
| `serverName` | `string` | No | `os.hostname()` | Host machine or container identifier. | Max 128 characters. |
| `initTimeoutMs` | `number` | No | `3000` | Maximum wait time (ms) for `/v1/init` on cold start before continuing in background recovery. | Minimum `100`ms. |
| `shutdownTimeoutMs`| `number` | No | `5000` | Maximum wait time (ms) allowed for graceful shutdown and buffer flushing. | Minimum `500`ms. |
| `maxQueueSize` | `number` | No | `10000` | Maximum number of events buffered in memory before dropping low-priority telemetry. | Positive integer. |
| `dropStrategy` | `'drop_oldest' \| 'drop_newest'` | No | `'drop_oldest'` | Queue eviction policy when maxQueueSize is reached. | Fatal errors are always protected. |
| `logger` | `PulseLogger` | No | Internal Console Logger | Custom logger adapter implementing `debug`, `info`, `warn`, `error`. | Must implement logging interface. |
| `logLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | No | `'info'` | Minimum severity level for SDK diagnostic output. | Enum. |
| `plugins` | `SDKPlugin[]` | No | `[]` | Custom SDK plugin interceptors. | Valid plugin implementations. |
| `eventProcessors` | `EventProcessor[]` | No | `[]` | Pipeline hooks to mutate or enrich events prior to transport. | Functions returning modified event or null. |
| `breadcrumbProcessors` | `BreadcrumbProcessor[]` | No | `[]` | Hooks to filter or modify breadcrumbs before ring-buffer storage. | Functions returning modified breadcrumb or null. |
| `logFormat` | `'json' \| 'pretty'` | No | `'json'` | Diagnostic log output format. | Enum. |
| `network` | `NetworkOptions` | No | `{ timeoutMs: 5000, maxRetries: 3 }` | HTTP client options for control-plane requests. | Object. |

### Fail-Open Initialization & Recovery Behavior

If the control-plane endpoint is unreachable (network partition, DNS failure, 5xx error, or timeout), `init()`:
1. Logs a diagnostic error (`Telemetry initialization failed; entering dormant state`).
2. Transitions the SDK into a **dormant background recovery state**.
3. Spawns an unref'd `BackgroundRecoveryWorker` that retries connection with exponential backoff and jitter.
4. **Returns `undefined` without throwing.** Your host application starts up immediately without delay or blocking.
5. As soon as the backend comes online, the SDK automatically promotes from dormant to active mode.

---

## 7. Remote Configuration Directives

Runtime telemetry policies (sampling rates, batch sizes, buffer thresholds, feature killswitches) are **centrally governed by the remote control plane (`POST /v1/init`)**, rather than hard-coded in customer applications.

Every 60 seconds, the SDK checks for remote configuration updates. When new directives arrive:
- **`sampling`**: Hot-swaps probabilistic sampling rates per event type and per route (e.g. `/health` sampled at `0.0`, `/checkout` sampled at `1.0`).
- **`killswitches`**: Instantly disables specific subsystems (`disableErrors`, `disableTracing`, `disableMetrics`, `disableLogs`, `disableCrons`).
- **`limits`**: Dynamically adjusts maximum batch sizes, maximum queue depths, and memory thresholds.
- **`privacy`**: Updates sensitive header redaction lists and regex PII rules.

---

## 8. Automatic Instrumentation

When imported, `@pulse-apm/node` automatically intercepts standard Node.js libraries and database drivers without requiring manual code changes:

| Target Library | Supported Versions | Interception Method | What Is Captured |
|---|---|---|---|
| **HTTP / HTTPS** | Node.js core | Monkey-patch / OTel | Client requests, response status, duration, headers. |
| **Fetch** | Node.js core `>= 18` | Undici instrumentation | Outbound HTTP requests, timings, errors. |
| **Express** | `>= 4.0.0` | Middleware / Layer hook | Route patterns (`/users/:id`), middleware timings, error handling. |
| **Fastify** | `>= 4.0.0` | Plugin / Hooks | Route execution, serialization time, status codes. |
| **PostgreSQL (`pg`)** | `>= 8.0.0` | Pool / Client prototype | SQL queries, parameterized statements, query duration, slow query tagging. |
| **MySQL / MySQL2** | `>= 2.0.0` | Connection prototype | Queries, transactions, query durations. |
| **MongoDB** | `>= 4.0.0` | Command listener | Commands (`find`, `update`, `insert`), database name, durations. |
| **Mongoose** | `>= 6.0.0` | Query middleware | Schema operations, validation errors, hook durations. |
| **Redis / ioredis** | `>= 4.0.0` | Client prototype | Redis commands (`GET`, `SET`, `HGETALL`), key prefixes, latency. |
| **Prisma** | `>= 4.0.0` | OTel / `$extends` | Client query spans, model actions, durations. |
| **BullMQ** | `>= 3.0.0` | Job processor wrapper | Job queues, job processing time, failures, retry counts. |
| **Axios** | `>= 0.27.0` | Interceptor | Outbound HTTP requests, headers, response status. |
| **GraphQL** | `>= 15.0.0` | Field resolver wrapper | Operation type (`query`/`mutation`), field execution time. |
| **KafkaJS** | `>= 2.0.0` | Producer / Consumer hooks | Message publish/consume latency, topic names. |
| **amqplib** | `>= 0.8.0` | Channel prototype | RabbitMQ queue publishes and consumes. |

---

## 9. Complete API Reference by Domain

Every function below is exported directly from the package entry point:
```ts
import { ... } from '@pulse-apm/node'
```

---

### A. Lifecycle & Operational Health

#### `init(options?: SDKInitOptions): Promise<Readonly<RemoteConfigResponse> | undefined>`
Initializes the SDK, starts auto-instrumentation, and connects to the control plane.
- **Parameters**: `options?: SDKInitOptions` (see [Section 6](#6-initialization-init)).
- **Returns**: `Promise<Readonly<RemoteConfigResponse> | undefined>`. Never throws.

#### `shutdown(timeoutMs?: number): Promise<ShutdownResult>`
Gracefully drains all 10 transport route queues, ends pending spans, flushes disk storage, deregisters process listeners, and stops background worker pools.
- **Parameters**: `timeoutMs?: number` (Default: `5000`ms).
- **Returns**: `Promise<ShutdownResult>` (`{ completed, timedOut, durationMs, remainingEvents, deadLetterCount, stepErrors }`).

#### `flush(timeoutMs?: number): Promise<void>`
Forces an immediate asynchronous drain of all pending batches across all transport routes.
- **Parameters**: `timeoutMs?: number` (Default: `5000`ms).
- **Returns**: `Promise<void>`.

#### `emergencyFlush(timeoutMs?: number): Promise<void>`
High-speed synchronous/fast drain intended for `uncaughtException` and `SIGSEGV` crash handlers. Drains fatal error queues without tearing down subsystems.
- **Parameters**: `timeoutMs?: number` (Default: `2000`ms).
- *(Formerly known as `crashFlush` in early versions.)*

#### `getConfig(): Readonly<RemoteConfigResponse> | null`
Returns the currently active, frozen remote configuration object, or `null` if the SDK is not yet initialized.

#### `getHealth(): HealthSnapshot`
Returns an instantaneous, comprehensive health snapshot across 15 SDK internal subsystems (heap utilization, memory pressure state, tenant quota exhaustion, route circuit breakers, queue size, dropped events, and persistent replay counts).
- *(Formerly known as `getSDKHealth` in early versions.)*

#### `loadEnvFileSafely(envFilePath?: string): Record<string, string>`
Safely parses and loads `.env` variables into `process.env` without throwing errors if the file is missing, empty, or unreadable.

---

### B. Event & Exception Capture

#### `captureException(error: unknown, severity?: ErrorSeverity | { severity?: ErrorSeverity } | SeverityLevel): void`
Captures an `Error` or exception. Automatically parses stack traces, resolves source maps, sanitizes PII, attaches the active scope and W3C trace ID, and routes the event to the `errors` transport pipeline.
- **Parameters**:
  - `error`: The thrown error object, string, or arbitrary exception.
  - `severity`: Optional severity (`'fatal'`, `'error'`, `'warning'`, `'info'`, `'debug'`). Default: `'error'`.
- *(Formerly known as `captureError` in early versions.)*

```ts
try {
  throw new Error('Database connection failed')
} catch (err) {
  captureException(err, 'fatal')
}
```

#### `captureMessage(message: string, severity?: SeverityLevel, context?: Record<string, unknown>): void`
Captures an informational, warning, or diagnostic text message event.
- **Parameters**:
  - `message: string`: Message text (automatically sanitized for secrets and PII).
  - `severity?: SeverityLevel`: Severity level (`'debug'`, `'info'`, `'warn'`, `'error'`). Default: `'info'`.
  - `context?: Record<string, unknown>`: Optional contextual attributes.

```ts
captureMessage('User upgraded to enterprise tier', 'info', { userId: 'usr_42' })
```

#### `captureRequest(event: RequestEvent): void`
Manually records an HTTP request/response transaction when not using automatic framework middleware. Automatically enriches the event with active OpenTelemetry trace IDs.

#### `captureEvent(event: CaptureEventInput): void`
Low-level canonical ingestion API for dispatching custom pre-structured telemetry events directly into the pipeline.

#### `captureMetric(name: string, value: number, type?: MetricType, options?: { tags?: Record<string, string>; unit?: string }): void`
Dispatches a custom metric data point to the metric aggregation registry (`'gauge'`, `'counter'`, or `'histogram'`).

#### `captureLog(level: CaptureLogLevel, message: string, ...args: unknown[]): void`
Captures a structured log message event into the `logs` transport pipeline with arguments scrubbed for sensitive data.
- **Parameters**:
  - `level`: `'debug' | 'info' | 'warn' | 'error' | 'fatal'`.
  - `message`: Log string.
  - `...args`: Additional metadata objects (max 10 kept, sanitized).

```ts
captureLog('info', 'Payment processed', { orderId: 'ord_123', amount: 49.99 })
```

#### `captureCronCheckIn(monitorSlug: string, status: 'ok' | 'error' | 'in_progress', options?: CronCheckInOptions): void`
Reports recurring job heartbeats and execution status (`in_progress`, `ok`, `error`) with elapsed duration.

```ts
captureCronCheckIn('billing-nightly', 'in_progress')
try {
  await runBilling()
  captureCronCheckIn('billing-nightly', 'ok', { duration: 1420 })
} catch (err) {
  captureCronCheckIn('billing-nightly', 'error')
}
```

#### `captureReplay(sessionId: string, segmentId: number, events: readonly unknown[]): void`
Submits a session replay recording chunk (stubbed and disabled by default in Node.js runtime).

#### `startProfile(profileId: string): Promise<boolean>`
Starts a CPU profiling session for the given `profileId`. Returns `true` if profiling started.

#### `stopProfile(profileId: string): Promise<void>`
Stops the CPU profiling session for `profileId` and queues the profile payload for transport.

---

### C. OpenTelemetry Metrics Instruments

All metric functions route into OpenTelemetry metric instruments and aggregate in memory with low CPU overhead.

```ts
import { incrementCounter, setGauge, recordHistogram, addUpDownCounter } from '@pulse-apm/node'

// Increment a counter
incrementCounter('http.requests.total', 1, { method: 'POST', status: '200' })

// Set an instantaneous gauge
setGauge('db.connection_pool.active', 12, { pool: 'read-replica' })

// Record a latency histogram sample
recordHistogram('api.response_time_ms', 42.5, { route: '/api/checkout' })

// Adjust an up-down counter
addUpDownCounter('queue.jobs.in_flight', 1, { queue: 'emails' })
```

---

### D. Scope, Tags, User & Breadcrumbs

Scope data is attached to the asynchronous execution branch via `AsyncLocalStorage` and automatically included with every captured error and transaction.

#### `setUser(user: User | null): void`
Attaches user identity (`id`, `username`, `email`, `ipAddress`) to the active scope. Pass `null` to clear user data.

```ts
setUser({
  id: 'usr_8921',
  email: 'alex@example.com',
  username: 'alexm',
})
```

#### `setTag(key: string, value: string): void` & `setTags(tags: Record<string, string>): void`
Sets indexable string tags for filtering in dashboards.

```ts
setTag('tier', 'premium')
setTags({ region: 'us-east-1', environment: 'production' })
```

#### `removeTag(key: string): void`
Removes a tag from the active execution scope.

#### `setExtra(key: string, value: unknown): void` & `setExtras(extras: Record<string, unknown>): void`
Sets non-indexed metadata to assist in debugging.

#### `removeExtra(key: string): void`
Removes an extra metadata field from the active scope.

#### `setContext(key: string, context: Record<string, unknown> | null): void`
Attaches a named structured context block.

```ts
setContext('subscription', { plan: 'enterprise', seats: 50 })
```

#### `getScopeData(): ScopeData`
Returns a read-only snapshot of all tags, extras, user information, and context blocks on the current scope.

#### `clearScope(): void`
Resets all user data, tags, extras, and context blocks from the active execution scope.

#### `addBreadcrumb(input: BreadcrumbInput): void`
Appends a breadcrumb to the active request's ring buffer (default max: 100). Breadcrumbs are attached to any error captured in the same async context.

```ts
addBreadcrumb({
  category: 'auth',
  message: 'Token validated successfully',
  level: 'info',
  data: { role: 'admin' },
})
```

#### `withScope<T>(fn: (scope: ScopeManager) => T): T`
Executes callback `fn` inside an isolated clone of the current scope. Modifications made within `fn` do not leak into outer scopes.

```ts
withScope((scope) => {
  scope.setTag('isolated', 'true')
  // Operations here only have this tag
})
```

---

### E. Context & Distributed Trace Propagation

#### `getTraceId(): string | null`
Returns the active 32-character hexadecimal W3C trace ID from `AsyncLocalStorage`, or `null` if no trace is active.

#### `getSpanId(): string | null`
Returns the active 16-character hexadecimal span ID from `AsyncLocalStorage`, or `null` if no span is active.

#### `getRequestContext(): ContextStore | undefined`
Returns the raw `ContextStore` instance attached to the current asynchronous execution branch.

#### `withContext<T>(store: ContextStore, fn: () => T): T`
Runs synchronous or asynchronous function `fn` with `store` bound to the current `AsyncLocalStorage` context.

#### `createContextStore(initial?: Partial<ContextStore>): ContextStore`
Instantiates a new `ContextStore` seed object with request ID, timestamps, and ring buffer breadcrumbs.

#### `bindContext<T>(target: T, store?: ContextStore): T`
Binds an existing function or EventEmitter to the active context store so asynchronous callbacks preserve context.

#### `extractTraceContext(carrier: Record<string, string | string[] | undefined>): Context`
Extracts W3C `traceparent` and `baggage` from incoming HTTP headers into an OpenTelemetry `Context`.

#### `injectTraceContext(carrier: Record<string, string | undefined>): void`
Injects the active W3C `traceparent` and `baggage` headers into an outgoing HTTP carrier object:

```ts
const headers: Record<string, string> = {}
injectTraceContext(headers)
await fetch('https://payment-service.internal/charge', { headers })
```

---

### F. Tracing, Custom Spans & Database Queries

#### `startSpan(name: string, options?: SpanOptions): PulseSpan`
Starts an un-scoped OpenTelemetry span. The caller is responsible for calling `span.end()`.

#### `withSpan<T>(name: string, fn: (span: PulseSpan) => Promise<T>, options?: SpanOptions): Promise<T>`
Executes an async callback within an active span. The span ends automatically upon promise resolution or rejection, with exceptions recorded.

```ts
const result = await withSpan('calculateTax', async (span) => {
  span.setAttribute('order.itemsCount', items.length)
  return computeTax(items)
})
```

#### `withSpanSync<T>(name: string, fn: (span: PulseSpan) => T, options?: SpanOptions): T`
Synchronous version of `withSpan`. Automatically ends upon completion or throw.

#### `trace<T>(name: string, fn: (span: PulseSpan) => T | Promise<T>, options?: SpanOptions): T | Promise<T>`
Ergonomic auto-detecting tracing function that transparently handles both synchronous and asynchronous callbacks.

#### `wrap<F>(name: string, fn: F, options?: SpanOptions): F`
Wraps a target function, returning an identical function signature that automatically creates an active span around each invocation.

```ts
const tracedCalculateTax = wrap('calculateTax', calculateTax)
```

#### `startBackgroundSpan(name: string, options?: BackgroundSpanOptions): PulseSpan`
Starts a detached background span that survives after the parent HTTP server span has closed, causally linked via OpenTelemetry `SpanLink`.

#### `withBackgroundSpan<T>(name: string, fn: (span: PulseSpan) => Promise<T>, options?: BackgroundSpanOptions): Promise<T>`
Executes an async task within a detached background span. Prevents background jobs from holding HTTP response traces open or creating memory leaks.

```ts
app.post('/api/checkout', async (req, res) => {
  res.json({ status: 'ok' })

  // Runs in background after response is sent:
  void withBackgroundSpan('sendConfirmationEmail', async (span) => {
    span.setAttribute('user.email', req.body.email)
    await mailer.sendReceipt(req.body)
  })
})
```

#### `startDbSpan(options: DbSpanOptions): PulseSpan`
Starts an OpenTelemetry database span with semantic attributes (`db.system`, `db.name`, `db.statement`) and slow-query threshold tracking.

#### `withDbSpan<T>(options: DbSpanOptions, fn: (span: PulseSpan) => Promise<T>): Promise<T>`
Executes an asynchronous database query within a tracked database span, automatically recording query duration, errors, and slow query tags (`db.slow_query = true`).

```ts
const users = await withDbSpan({
  system: 'postgresql',
  table: 'users',
  operation: 'SELECT',
  statement: 'SELECT id, email FROM users WHERE active = true',
  slowQueryThresholdMs: 100, // Tagged as slow query if execution takes >= 100ms
}, async (span) => {
  return await db.query('SELECT id, email FROM users WHERE active = true')
})
```

#### `withDbSpanSync<T>(options: DbSpanOptions, fn: (span: PulseSpan) => T): T`
Synchronous version of `withDbSpan`.

#### `getActiveSpan(): PulseSpan | undefined`
Returns the currently active OpenTelemetry span, or `undefined` if none is active.

#### `getActiveBackgroundSpanCount(): number`
Returns the count of currently in-flight background spans.

#### `flushTracer(): Promise<void>`
Flushes active OpenTelemetry `NodeTracerProvider` batch span processors.

#### `computeExclusiveDuration(spanIntervals: SpanInterval[], spanDurationMs: number): DurationBreakdown`
Calculates self-time vs child execution time across a tree of concurrent and sequential span intervals.

---

### G. Framework & Middleware Instrumentation

#### `pulseMiddleware(options?: PulseExpressOptions): RequestHandler`
Express request monitoring middleware. Initializes `RequestContext` inside `AsyncLocalStorage`, extracts incoming W3C trace headers, enriches the active OpenTelemetry server span with route details, and emits transaction telemetry.
*(Formerly known as `monitorMiddleware` in early versions.)*

| Option | Type | Default | Description |
|---|---|---|---|
| `ignorePaths` | `readonly (string \| RegExp)[]` | `[]` | Exact/prefix paths or regular expressions to ignore (e.g. `['/health', /^\/static\/.*/]`). |
| `ignoreMethods` | `readonly string[]` | `[]` | Case-insensitive HTTP methods to skip (e.g. `['OPTIONS', 'HEAD']`). |
| `maxBreadcrumbs` | `number` | `100` | Maximum number of breadcrumbs stored in request-scoped storage. |
| `trustedProxies` | `readonly string[]` | `[]` | Trusted reverse proxy IPs used to extract real client IP from `X-Forwarded-For`. |
| `instrumentMiddleware` | `boolean` | `false` | When `true`, automatically measures execution durations of Express middleware layers. |
| `minMiddlewareDurationMs` | `number` | `2.0` | Minimum execution duration in ms required for a middleware layer to emit a child span. |
| `ignoreMiddlewares` | `readonly (string \| RegExp)[]` | `['query', 'expressInit']` | Names of middleware layers to exclude from layer profiling. |

#### `expressErrorHandler(): ErrorRequestHandler`
Terminal Express error-handling middleware (`(err, req, res, next)`). Catches unhandled errors passed to `next(err)`, reports them via `captureException`, marks the active server span as `ERROR`, and passes the error to downstream custom handlers. Must be mounted after all application routes.

#### `instrumentExpress(app: Express, options?): void`
Profiles Express application middleware layers to measure execution duration without manually wrapping each layer.

#### `pulseFastifyPlugin(fastify: FastifyInstance, options?: PulseFastifyOptions): Promise<void>`
Native Fastify plugin for request tracing, AsyncLocalStorage binding, and error capture.
*(Formerly known as `fastifyPulsePlugin` in early versions.)*

---

### H. Driver Instrumentation Factories & Helpers

- **`registerBootstrapAutoInstrumentations()`**: Automatically executed on import. Registers fail-safe monkey-patch hooks for 15 supported drivers.
- **`registerAutoInstrumentations(options?: AutoInstrumentOptions)`**: Programmatically registers or reconfigures auto-instrumentation drivers with custom driver options.
- **`registerEsmLoaderHooks()`**: Registers Node.js ESM module resolution customization hooks for zero-code `--import @pulse-apm/node/register`.
- **`createGraphQLInstrumentation(options?)`**: Creates GraphQL resolver tracing instrumentation.
- **`createPrismaInstrumentation(options?)`**: Creates OpenTelemetry instrumentation for Prisma.
- **`pulsePrismaExtension(options?)`**: Returns a `$extends` client extension for Prisma queries.
- **`instrumentPrismaClientInstance(prisma, options?)`**: Direct instance instrumentation wrapper for `PrismaClient`.
- **`createMongoDBInstrumentation(options?)`**: Creates MongoDB driver instrumentation.
- **`createMongooseInstrumentation(options?)`**: Creates Mongoose query & schema instrumentation.
- **`createRedisInstrumentation(options?)`**: Creates Redis (ioredis / node-redis) instrumentation.
- **`createBullMQInstrumentation(options?)`**: Creates BullMQ queue and worker job instrumentation.
- **`createAxiosInstrumentation(options?)`**: Creates outgoing HTTP instrumentation for Axios.
- **`createPgInstrumentation(options?)`**: Creates PostgreSQL driver (`pg`) instrumentation.
- **`patchPgPoolConnectOnce()`**: Patches PostgreSQL connection pool to prevent leak on connect.
- **`createMySQLInstrumentation(options?)`**: Creates MySQL/MySQL2 driver instrumentation.
- **`patchEventEmitter(emitter)` / `unpatchEventEmitter(emitter)`**: Binds context across Node.js event emitter listeners.
- **`installHttpLifecycleGuard()` / `uninstallHttpLifecycleGuard()`**: Guards HTTP client sockets against race conditions in OTel hooks.
- **`isOtelInstrumentationError(error)`**: Identifies whether an error originated inside OpenTelemetry internals.

---

### I. Diagnostic Logging & Error Classification

#### `setLogger(logger: Logger): void`
Replaces the internal SDK diagnostic logger with a custom logger conforming to `{ debug, info, warn, error }`.

#### `setDebugMode(enabled: boolean): void`
Enables or disables verbose diagnostic console logging.

#### `setLogLevel(level: SeverityLevel): void`
Sets the minimum diagnostic log level (`'debug'`, `'info'`, `'warn'`, `'error'`).

#### `classifyError(error: unknown): ErrorClassification`
Classifies an arbitrary error into category, severity, and root cause (`database`, `network`, `auth`, `validation`, `internal`).

#### `severityFromString(level: string): Severity`
Parses a string level into a typed `Severity` enum.

#### `isSeverityGte(a: Severity, b: Severity): boolean`
Returns `true` if severity `a` is greater than or equal to severity `b`.

#### `doesSeverityMeetThreshold(level: Severity, threshold: Severity): boolean`
Evaluates whether a given severity satisfies a configured threshold.

---

### J. Canonical `Pulse` Facade Object

All primary SDK methods are also accessible directly via the `Pulse` facade object:

```ts
import { Pulse } from '@pulse-apm/node'
// or: import Pulse from '@pulse-apm/node'

await Pulse.init({ apiKey: process.env.PULSE_API_KEY! })

app.use(Pulse.pulseMiddleware({ instrumentMiddleware: true }))
app.use(Pulse.expressErrorHandler())

Pulse.captureException(new Error('Something broke'))
Pulse.captureMessage('Order placed', 'info')
Pulse.captureMetric('cache.miss', 1)
Pulse.incrementCounter('orders.total')
Pulse.setGauge('active.connections', 8)
Pulse.recordHistogram('render.time', 12.4)
Pulse.addBreadcrumb({ category: 'cart', message: 'Item added' })
Pulse.setUser({ id: 'user_1' })
Pulse.setTag('tenant', 'acme')

await Pulse.withSpan('processPayment', async (span) => { ... })
await Pulse.withBackgroundSpan('emailReceipt', async (span) => { ... })
await Pulse.withDbSpan({ system: 'postgresql' }, async () => { ... })

const traceId = Pulse.getTraceId()
const health = Pulse.getHealth()

await Pulse.flush()
await Pulse.shutdown()
```

---

## 10. Express.js Deep Dive

### Enabling Middleware Duration Profiling (`instrumentMiddleware: true`)

Express applications frequently experience latency bottlenecks inside third-party middlewares (such as body parsers, JWT token verification, CORS, or custom permission filters).

By passing `instrumentMiddleware: true` to `pulseMiddleware()`, Pulse profiles the execution duration of every middleware layer in your Express stack:

```ts
import express from 'express'
import { init, pulseMiddleware, expressErrorHandler } from '@pulse-apm/node'

await init({ apiKey: process.env.PULSE_API_KEY! })

const app = express()

app.use(pulseMiddleware({
  // 1. Enable layer profiling:
  instrumentMiddleware: true,

  // 2. Only emit child spans for middlewares taking >= 2ms:
  minMiddlewareDurationMs: 2,

  // 3. Skip built-in or noisy middlewares:
  ignoreMiddlewares: ['expressInit', 'query'],
}))

// Authentication layer taking > 2ms will emit a child span:
// "express.middleware: authenticateJwt"
app.use(async function authenticateJwt(req, res, next) {
  await verifyToken(req.headers.authorization)
  next()
})

app.get('/api/data', (req, res) => res.json({ ok: true }))

app.use(expressErrorHandler())
```

---

## 11. Fastify Deep Dive

```ts
import Fastify from 'fastify'
import { init, pulseFastifyPlugin } from '@pulse-apm/node'

await init({ apiKey: process.env.PULSE_API_KEY! })

const fastify = Fastify()

await fastify.register(pulseFastifyPlugin, {
  ignorePaths: ['/health', '/metrics'],
  ignoreMethods: ['OPTIONS'],
  maxBreadcrumbs: 100,
  captureHeaders: true,
})

fastify.get('/api/users', async () => ({ users: [] }))

await fastify.listen({ port: 3000 })
```

---

## 12. Database Instrumentation & Slow Query Tagging

Pulse provides semantic database tracing with automatic slow query tagging:

```ts
import { withDbSpan } from '@pulse-apm/node'

const users = await withDbSpan({
  system: 'postgresql',
  table: 'users',
  operation: 'SELECT',
  statement: 'SELECT * FROM users WHERE active = true',
  slowQueryThresholdMs: 100, // Marked as db.slow_query = true if latency >= 100ms
}, async (span) => {
  return await pool.query('SELECT * FROM users WHERE active = true')
})
```

---

## 13. Detached Background Task Tracing (`withBackgroundSpan`)

In modern Node.js web services, operations such as sending confirmation emails, dispatching webhooks, or updating analytics are triggered after responding to the client.

If wrapped in ordinary OpenTelemetry child spans, one of two bugs occurs:
1. The root HTTP trace cannot finalize until the background task completes, keeping connections open.
2. The HTTP trace closes immediately, causing background spans to become orphan spans that are dropped.

`withBackgroundSpan` solves this by starting an independent, detached root trace linked via OpenTelemetry `SpanLink`:

```ts
app.post('/api/orders', async (req, res) => {
  const order = await createOrder(req.body)
  res.status(201).json(order)

  // Fires in background; does NOT keep HTTP request open:
  void withBackgroundSpan('email.sendConfirmation', async (span) => {
    span.setAttribute('order.id', order.id)
    await mailer.sendReceipt(order)
  })
})
```

---

## 14. Cron & Job Monitoring (`captureCronCheckIn`)

Monitor scheduled jobs, BullMQ workers, and batch scripts:

```ts
import { captureCronCheckIn } from '@pulse-apm/node'

// 1. Report start of job:
captureCronCheckIn('sync-inventory', 'in_progress')

const startTime = Date.now()
try {
  await syncWarehouseInventory()

  // 2. Report success with duration:
  captureCronCheckIn('sync-inventory', 'ok', {
    duration: Date.now() - startTime,
  })
} catch (err) {
  // 3. Report failure:
  captureCronCheckIn('sync-inventory', 'error')
  throw err
}
```

---

## 15. Reliability, Delivery Semantics & Load Shedding

### Priority Eviction Hierarchy

Telemetry events are ingested into 4 discrete priority classes:
1. **`P0_CRITICAL`**: Uncaught exceptions, process crashes, fatal errors.
2. **`P1_ERROR`**: Handled exceptions, HTTP 5xx responses.
3. **`P2_REQUEST`**: Normal HTTP transactions and database spans.
4. **`P3_LOW`**: Background metrics, breadcrumbs, debug messages.

Under memory or queue pressure, `AdaptivePressureMonitor` dynamically drops lower-priority events (`P3` first, then `P2`) to ensure fatal crashes and customer errors are never lost.

### Circuit Breakers

Each of the 10 transport routes maintains an independent circuit breaker. If an ingestion route returns consecutive 5xx or network errors (threshold: 5 failures), the route opens and cools down for 30 seconds, preventing network storming.

### Worker Pool Serialization & Gzip

Batches larger than 50KB automatically offload JSON serialization and Gzip compression to a background `WorkerPool` thread pool, preventing event-loop lag in high-throughput services.

### Offline Disk Spooling

If the host application loses internet connectivity, events are persisted to a local disk queue (`~/.pulse-sdk/events`) with SQLite/file backup. Upon reconnection, replayed events are automatically transmitted without duplicate delivery.

---

## 16. Privacy, PII Scrubbing & Security

Before any telemetry is buffered or transmitted, the `SecurityScrubber` applies three layers of sanitization:
1. **Header Sanitization**: Authorization tokens, cookies, API keys, and session cookies (`authorization`, `cookie`, `set-cookie`, `x-api-key`) are redacted.
2. **Body & Query Scrubbing**: Sensitive keys (`password`, `token`, `secret`, `credit_card`, `ssn`, `cvv`) in request bodies and JSON attributes are replaced with `[REDACTED]`.
3. **PII Masking**: Regular expressions automatically detect and mask email addresses and IPv4/IPv6 addresses embedded in error messages or URLs.

---

## 17. Graceful Shutdown & Kubernetes Lifecycle

To ensure no in-flight telemetry is lost during rolling deployments or pod evictions, listen for `SIGTERM` and `SIGINT` signals:

```ts
import { shutdown, emergencyFlush } from '@pulse-apm/node'

// Graceful Kubernetes termination (SIGTERM)
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, draining telemetry...')
  await shutdown(10000) // 10-second timeout budget
  process.exit(0)
})

// Uncaught fatal crash handling
process.on('uncaughtException', async (error) => {
  console.error('Fatal crash:', error)
  // Fast emergency flush drains fatal errors without waiting for subsystems
  await emergencyFlush(2000)
  process.exit(1)
})
```

---

## 18. Production Best Practices

1. **Preload the SDK via `--import`**: Always run `node --import @pulse-apm/node/register dist/server.js`.
2. **Never Hardcode API Keys**: Load `PULSE_API_KEY` from environment variables or secrets managers.
3. **Always Mount `expressErrorHandler`**: Place it after all routes to capture unhandled promise rejections.
4. **Use `withBackgroundSpan` for Post-Response Work**: Never attach asynchronous tasks directly to the closed HTTP request trace.
5. **Set Realistic Shutdown Budgets**: Set `shutdownTimeoutMs` in accordance with your container termination grace period (e.g. 5–10 seconds).

---

## 19. Common Integration Mistakes

```
❌ INCORRECT: Initializing SDK after importing Express or database drivers
import express from 'express'
import { Pool } from 'pg'
import { init } from '@pulse-apm/node'
await init() // Too late! Drivers are already loaded without hooks.

✅ CORRECT: Initialize Pulse before importing application drivers (or use --import)
import { init } from '@pulse-apm/node'
await init({ apiKey: process.env.PULSE_API_KEY! })
const { default: express } = await import('express')
const { Pool } = await import('pg')

---

❌ INCORRECT: Passing remote telemetry options to init()
await init({
  apiKey: '...',
  sampleRate: 0.5, // Error: unknown key! Governed by remote config.
})

✅ CORRECT: Only pass local integration options to init()
await init({
  apiKey: '...',
  applicationName: 'order-service',
  environment: 'production',
})
```

---

## 20. Troubleshooting Guide

### 1. SDK Does Not Initialize
- **Check API Key**: Verify `PULSE_API_KEY` is present and does not contain whitespace or control characters.
- **Check Backend Connectivity**: Ensure the host can reach `PULSE_ENDPOINT` (`curl -I https://api.pulse.dev/v1/init`).
- **Inspect Diagnostics**: Run with `PULSE_SDK_CONSOLE_DEBUG=true` to view raw connection messages.

### 2. Spans Not Appearing in Dashboard
- **Verify Remote Sampling Rate**: If the remote sampling rate is set to `0.1`, 90% of non-error traces are dropped at head sampling.
- **Check Flush Intervals**: By default, spans flush every 5,000ms. In short-lived CLI scripts, call `await flush()` before process exit.
- **Check Missing `span.end()`**: If using imperative `startSpan`, verify `span.end()` is invoked.

### 3. High Memory Pressure
- Inspect `getHealth().memory` and `getHealth().queueSize`.
- If the application is under heavy load, verify that `adaptivePressure` is active and shedding low-priority (`P3`) telemetry.

---

## 21. Migration Guide (Legacy to Modern Function Names)

If you are upgrading from earlier versions of the SDK, you must update your function imports according to this table as legacy names have been retired in favor of standard naming conventions:

| Modern Canonical Function Name | Legacy Name | Subsystem / Purpose |
|---|---|---|
| **`pulseMiddleware`** | `monitorMiddleware` | Express request monitoring middleware |
| **`expressErrorHandler`** | *(new)* | Express terminal error-handling middleware |
| **`pulseFastifyPlugin`** | `fastifyPulsePlugin` | Fastify request monitoring plugin |
| **`captureException`** | `captureError` | Error & exception reporting |
| **`emergencyFlush`** | `crashFlush` | Synchronous emergency flush on process crash |
| **`getHealth`** | `getSDKHealth` | SDK operational diagnostics snapshot |

---

## License

ISC © Pulse APM Team
