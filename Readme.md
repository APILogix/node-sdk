# @lynktrace/node

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
- [4. Quick Start by Environment](#4-quick-start-by-environment)
  - [Minimal Node.js Example](#minimal-nodejs-example)
  - [Express.js Application](#expressjs-application)
  - [Fastify Application](#fastify-application)
  - [Serverless & AWS Lambda (`wrapHandler`)](#serverless--aws-lambda-wraphandler)
  - [NestJS Application](#nestjs-application)
  - [Background Workers & Job Queues (BullMQ / CLI)](#background-workers--job-queues-bullmq--cli)
- [5. Process Bootstrap & Zero-Code Preload](#5-process-bootstrap--zero-code-preload)
- [6. Initialization (`init`)](#6-initialization-init)
  - [Complete `init()` Options Reference](#complete-init-options-reference)
  - [Fail-Open Initialization & Recovery Behavior](#fail-open-initialization--recovery-behavior)
- [7. Feature Control & Toggles: What to Use and How to Turn Off Features](#7-feature-control--toggles-what-to-use-and-how-to-turn-off-features)
  - [Disabling Subsystems via Remote Config or Local Flags](#disabling-subsystems-via-remote-config-or-local-flags)
  - [Disabling Disk Storage / Offline Queue (Serverless & Read-Only Disks)](#disabling-disk-storage--offline-queue-serverless--read-only-disks)
  - [Disabling Specific Auto-Instrumentations](#disabling-specific-auto-instrumentations)
  - [Emergency Operational Killswitches](#emergency-operational-killswitches)
  - [Sampling Controls & Per-Route Overrides](#sampling-controls--per-route-overrides)
  - [Cost Governor, Rate Limits & Metric Cardinality Caps](#cost-governor-rate-limits--metric-cardinality-caps)
  - [Privacy & PII Scrubbing Toggles](#privacy--pii-scrubbing-toggles)
- [8. Remote Configuration Directives](#8-remote-configuration-directives)
- [9. Automatic Instrumentation](#9-automatic-instrumentation)
- [10. Complete API Reference by Domain](#10-complete-api-reference-by-domain)
  - [A. Lifecycle, Serverless & Operational Health](#a-lifecycle-serverless--operational-health)
  - [B. Event & Exception Capture](#b-event--exception-capture)
  - [C. OpenTelemetry Metrics Instruments](#c-opentelemetry-metrics-instruments)
  - [D. Scope, Tags, User & Breadcrumbs](#d-scope-tags-user--breadcrumbs)
  - [E. Context & Distributed Trace Propagation](#e-context--distributed-trace-propagation)
  - [F. Tracing, Custom Spans & Database Queries](#f-tracing-custom-spans--database-queries)
  - [G. Framework & Middleware Instrumentation](#g-framework--middleware-instrumentation)
  - [H. Driver Instrumentation Factories & Helpers](#h-driver-instrumentation-factories--helpers)
  - [I. Diagnostic Logging & Error Classification](#i-diagnostic-logging--error-classification)
  - [J. Canonical `LynkTrace` Facade Object](#j-canonical-lynktrace-facade-object)
- [11. Server & Runtime Deployment Guides](#11-server--runtime-deployment-guides)
  - [Express.js Deep Dive](#expressjs-deep-dive)
  - [Fastify Deep Dive](#fastify-deep-dive)
  - [Serverless & Cloud Functions Deep Dive (AWS Lambda, Vercel, GCP)](#serverless--cloud-functions-deep-dive-aws-lambda-vercel-gcp)
  - [NestJS Deep Dive](#nestjs-deep-dive)
  - [Native Node.js HTTP / HTTPS](#native-nodejs-http--https)
  - [Background Job Processors & Queues](#background-job-processors--queues)
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

`@lynktrace/node` is engineered with an absolute **fail-open design**: telemetry operations must never degrade, block, leak memory, or crash the host application under any conditions (network outages, invalid keys, rate limits, or memory pressure).

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
npm install @lynktrace/node

# pnpm
pnpm add @lynktrace/node

# yarn
yarn add @lynktrace/node
```

---

## 4. Quick Start

### Minimal Node.js Example

```ts
import { init, captureException, captureMessage, flush } from '@lynktrace/node'

// Initialize the SDK
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
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

In Express, mount **`lynktraceMiddleware`** at the top of your middleware stack and **`expressErrorHandler`** at the bottom:

```ts
import express from 'express'
import { init, lynktraceMiddleware, expressErrorHandler, captureException } from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'order-api',
})

const app = express()

// 1. MUST BE FIRST MIDDLEWARE: Starts request trace, AsyncLocalStorage, and binds context
app.use(lynktraceMiddleware({
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
import { init, lynktraceFastifyPlugin } from '@lynktrace/node'

await init({ apiKey: process.env.LYNKTRACE_API_KEY! })

const fastify = Fastify()

// Register the LynkTrace Fastify plugin
await fastify.register(lynktraceFastifyPlugin, {
  ignorePaths: ['/healthz'],
  captureHeaders: true,
})

fastify.get('/api/users/:id', async (request, reply) => {
  return { id: (request.params as any).id }
})

```

### Serverless & AWS Lambda (`wrapHandler`)

In serverless runtimes (AWS Lambda, Vercel, Google Cloud Functions), background timers freeze immediately when the handler returns. Use **`wrapHandler`** to set `callbackWaitsForEmptyEventLoop = false` and guarantee synchronous in-memory HTTP flushing of all traces and errors before the container freezes:

```ts
import { init, wrapHandler } from '@lynktrace/node'

// Initialize once during Lambda cold start (outside the handler)
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'order-processor-fn',
  // Disable disk storage since serverless runtimes are stateless or have read-only filesystems:
  offlineQueue: false,
})

// Wrap your handler function:
export const handler = wrapHandler(async (event: any, context: any) => {
  const orderId = event.pathParameters?.id
  return {
    statusCode: 200,
    body: JSON.stringify({ message: `Order ${orderId} processed` }),
  }
}, {
  flushTimeoutMs: 1500, // Maximum ms to wait for HTTP flush before lambda responds
  captureErrors: true,  // Automatically captures unhandled exceptions with captureException
})
```

### NestJS Application

In NestJS, initialize LynkTrace in `main.ts` before creating the Nest application, mount `lynktraceMiddleware`, and bind a global exception filter:

```ts
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { init, lynktraceMiddleware, expressErrorHandler, captureException } from '@lynktrace/node'
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'nest-backend',
})

// Global Exception Filter for unhandled NestJS exceptions
@Catch()
export class LynkTraceExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse()
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR

    if (status >= 500) {
      captureException(exception)
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
    })
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.use(lynktraceMiddleware({ instrumentMiddleware: true }))
  app.useGlobalFilters(new LynkTraceExceptionFilter())
  await app.listen(3000)
}
bootstrap()
```

### Background Workers & Job Queues (BullMQ / CLI)

For queues, cron jobs, or batch CLI scripts, use `withBackgroundSpan` and call `await flush()` before process exit:

```ts
import { init, withBackgroundSpan, captureException, flush } from '@lynktrace/node'
import { Worker } from 'bullmq'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'email-worker',
})

const worker = new Worker('emails', async (job) => {
  return await withBackgroundSpan(`processJob:${job.name}`, async (span) => {
    span.setAttribute('job.id', job.id!)
    span.setAttribute('job.name', job.name)
    try {
      await sendEmail(job.data)
    } catch (err) {
      captureException(err)
      throw err
    }
  })
})
```

---

## 5. Process Bootstrap & Zero-Code Preload

To guarantee that auto-instrumentation intercepts Node.js core modules (`http`, `https`, `fetch`) and third-party drivers (`pg`, `mysql2`, `mongodb`, `redis`) before your application requires them, use Node's native `--import` flag:

```bash
# Node.js >= 18.19.0 (ESM & CJS)
node --import @lynktrace/node/register dist/server.js

# Or in your package.json scripts:
{
  "scripts": {
    "start": "node --import @lynktrace/node/register dist/server.js"
  }
}
```

When started with `--import @lynktrace/node/register`, monkey-patching hooks are registered immediately at process startup. Your application code then simply calls `await init({ apiKey: ... })`.

---

## 6. Initialization (`init`)

The `init(options)` function establishes connection with the LynkTrace control plane, fetches the remote configuration snapshot (`POST /v1/init`), activates enabled subsystems, and sets up process shutdown hooks.

```ts
import { init } from '@lynktrace/node'

const config = await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'payment-gateway',
  applicationVersion: '2.4.0',
  debug: false,
})
```

> [!NOTE]
> **Remote vs. Local Configuration Boundary**:
> - **Ingestion Endpoint**: Configured via the `LYNKTRACE_ENDPOINT` or `SDK_BASE_URL` environment variables (default: `https://api.lynktrace.com`).
> - **Environment**: Authoritatively assigned by the control plane based on your API key (defaults to `'production'` during initial bootstrap).
> - **In-Memory Queue Ceilings & Eviction**: Controlled centrally by Remote Configuration (`config.limits.maxQueueSize`, `config.transport.queue.maxSize`, `config.transport.queue.overflowStrategy: 'drop_oldest' | 'drop_newest'`) to prevent memory exhaustion on client hosts.
> - **Disk Queue Size**: Configured locally via the `offlineQueue` option (see below).

### Complete `init()` Options Reference

The options object passed to `init()` is strictly validated using Zod (`sdkInitOptionsSchema.strict()`). Passing unrecognized keys triggers an `INVALID_INIT_OPTIONS` validation error and places the SDK into dormant recovery mode.

| Parameter | Type | Required | Default | Description | Constraints |
|---|---|---|---|---|---|
| `apiKey` | `string` | **Yes** | — | Project API authentication token. | Non-empty printable string. |
| `applicationName` | `string` | No | Auto from `package.json` | Name of your service or application. | Trimmed string. |
| `applicationVersion` | `string` | No | Auto from `package.json` | Release version of your application. | Trimmed string. |
| `packageJsonPath` | `string` | No | `undefined` (cwd traversal) | Explicit filesystem path to `package.json` for custom layouts or monorepos. | Trimmed path string. |
| `debug` | `boolean` | No | `false` | Enables verbose diagnostic console logging. | Boolean. |
| `logLevel` | `'debug' \| 'info' \| 'warning' \| 'error' \| 'fatal'` | No | `'info'` | Minimum severity level for SDK diagnostic output. | Enum. |
| `initTimeoutMs` | `number` | No | `3000` | Maximum wait time (ms) for `/v1/init` on cold start before entering dormant recovery. | Integer `100` – `30000`ms. |
| `initRetries` | `number` | No | `2` | Number of retries for transient `/v1/init` failures within `initTimeoutMs`. | Integer `0` – `3`. |
| `shutdownTimeoutMs`| `number` | No | `10000` | Maximum wait time (ms) allowed for graceful shutdown and buffer flushing. | Integer `1000` – `60000`ms. |
| `crashTimeoutMs` | `number` | No | `2000` | Maximum wait time (ms) for emergency telemetry drain on fatal unhandled crashes. | Integer `100` – `30000`ms. |
| `handleSignals` | `boolean` | No | `true` | Automatically registers `SIGTERM` and `SIGINT` process listeners. Set `false` in serverless/Lambda. | Boolean. |
| `exitOnUncaughtException` | `boolean` | No | `true` | Whether to terminate the process after an `uncaughtException` once flush completes. Set `false` in test runners. | Boolean. |
| `onFatalError` | `(error: Error) => void` | No | — | Optional callback invoked immediately prior to process termination on fatal exceptions. | Function. |
| `offlineQueue` | `boolean \| OfflineQueueInitOptions` | No | `true` | Controls disk persistence fallback. Pass `false` to disable disk storage completely (recommended for serverless/Lambda). | Boolean or Options Object (see below). |
| `beforeSend` | `(event) => event \| null` | No | — | Pre-transport inspection hook. Return `null` to drop the event, or return a modified event object. | Synchronous or async function. |
| `beforeBreadcrumb` | `(crumb, hint?) => crumb \| null` | No | — | Ring-buffer hook to filter or mutate breadcrumbs before storage. Return `null` to drop. | Synchronous function. |
| `plugins` | `SDKPlugin[]` | No | `[]` | Custom SDK plugin interceptors. | Valid plugin implementations. |
| `eventProcessors` | `EventProcessor[]` | No | `[]` | Pipeline hooks to mutate or enrich events prior to transport. | Functions returning modified event or null. |
| `sourceMaps` | `SourceMapOptions` | No | Auto-detected | Local/remote source-map resolution for error stack traces. | `{ paths?: string[], allowRemote?: boolean, embedSourceContent?: boolean }`. |

#### `offlineQueue` Configuration (Disk Queue Size & Limits)

When configuring the persistent offline queue in `init()`, you can customize disk queue size, capacity, and retention:

```ts
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  offlineQueue: {
    enabled: true,
    directory: '.lynktrace-spool',          // Local directory for spool files (default: ~/.lynktrace/events or /tmp on serverless)
    maxEvents: 10000,                   // Disk queue capacity (1 - 100,000 events)
    maxFileSizeBytes: 10 * 1024 * 1024, // 10MB maximum spool file size (1KB - 100MB)
    eventTtlMs: 24 * 60 * 60 * 1000,    // Event time-to-live before expiration (1 min - 7 days)
    ioTimeoutMs: 5000,                  // Timeout protection against slow/frozen disk I/O (500ms - 60s)
    flushDebounceMs: 1000,              // Debounce delay before background flush to disk (0 - 60s)
  },
})
```

### Fail-Open Initialization & Recovery Behavior

If the control-plane endpoint is unreachable (network partition, DNS failure, 5xx error, or timeout), `init()`:
1. Logs a diagnostic error (`Telemetry initialization failed; entering dormant state`).
2. Transitions the SDK into a **dormant background recovery state**.
3. Spawns an unref'd `BackgroundRecoveryWorker` that retries connection with exponential backoff and jitter.
4. **Returns `undefined` without throwing.** Your host application starts up immediately without delay or blocking.
5. As soon as the backend comes online, the SDK automatically promotes from dormant to active mode.

---

## 7. Feature Control & Toggles: What to Use and How to Turn Off Features

Every capability in `@lynktrace/node` is modular and can be dynamically enabled, tuned, or completely silenced. This section outlines how to disable or customize each feature.

### Disabling Subsystems via Remote Config or Local Flags

Top-level subsystems can be turned off either in the remote control plane snapshot or via remote policy updates. When disabled, the SDK will not instantiate the subsystem, allocate buffers, or consume CPU/memory for those events:

```json
{
  "features": {
    "tracing": true,          // Distributed tracing & span generation
    "requestCapture": true,   // Automatic incoming HTTP request transaction capture
    "errors": true,           // Automatic and manual error / exception tracking
    "metrics": true,          // Runtime and custom metrics collection
    "logging": false,         // Structured log forwarding (turn off if using Datadog/CloudWatch)
    "profiling": false,       // Continuous CPU/heap profiling (turn off to eliminate profiling overhead)
    "crons": true,            // Cron job heartbeat monitoring
    "runtimeMetrics": true,   // Node.js process metrics (heap, event-loop lag, GC)
    "eventLoopMonitoring": true, // Event-loop lag histogram sampling
    "gcMonitoring": true      // Garbage collection pause monitoring
  }
}
```

### Disabling Disk Storage / Offline Queue (Serverless & Read-Only Disks)

By default, the SDK spools undelivered events to local disk during network outages or restarts. In stateless serverless runtimes (AWS Lambda, Vercel), container sandboxes, or read-only filesystems (`EROFS`), disk writes are unnecessary or forbidden.

You can turn off disk persistence completely in `init()`:

```ts
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  offlineQueue: false, // Disables disk spooling completely; runs in 100% in-memory mode
})
```

Or configure fine-grained disk parameters:
```ts
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  offlineQueue: {
    enabled: true,
    directory: '/tmp/custom-events', // Custom directory (defaults to /tmp on serverless)
    maxEvents: 5000,                 // Maximum events queued on disk
    maxFileSizeBytes: 5 * 1024 * 1024, // 5MB max file size before rotation
    ioTimeoutMs: 3000,               // 3-second timeout protection against frozen disks
  },
})
```

> [!NOTE]
> **Automatic Read-Only Fallback**: If you deploy on a read-only filesystem without passing `offlineQueue: false`, the SDK automatically detects `EROFS` / `EACCES` during initialization, logs a debug message, and gracefully degrades to **pure in-memory mode** without throwing errors or crashing.

### Disabling Specific Auto-Instrumentations

If your application already uses custom instrumentation or you want to avoid overhead on specific libraries, you can disable individual auto-instrumentation drivers via remote config:

```json
{
  "instrumentation": {
    "http": true,        // Core Node.js HTTP/HTTPS client/server
    "fetch": true,       // Native global fetch / Undici
    "axios": false,      // Disable Axios interceptor (avoids duplicate client spans)
    "express": true,     // Express route and middleware hooks
    "fastify": false,    // Disable Fastify plugin
    "pg": true,          // PostgreSQL (pg) driver
    "mysql2": false,     // Disable MySQL2 hooks
    "mongodb": true,     // MongoDB driver command listeners
    "redis": true,       // Redis / ioredis commands
    "prisma": true,      // Prisma ORM queries
    "bullmq": true,      // BullMQ queue job tracing
    "graphql": false     // Disable GraphQL field resolver tracing
  }
}
```

### Emergency Operational Killswitches

For immediate incident mitigation without redeploying application code, the control plane can activate remote killswitches to instantly silence the SDK:

| Killswitch | Effect |
|---|---|
| `disableSDK: true` | Completely disables all SDK operations. All APIs become zero-overhead no-ops. |
| `disableTracing: true` | Halts all span generation and distributed context injection. |
| `disableMetrics: true` | Stops all metric collection and aggregations. |
| `disableErrors: true` | Ignores all handled and unhandled exception capture. |
| `disableLogs: true` | Drops all structured log telemetry. |
| `disableTransport: true` | Freezes all outbound HTTP requests while keeping in-memory APIs safe. |

### Sampling Controls & Per-Route Overrides

Control telemetry volume and network bandwidth using probabilistic head sampling and route-level overrides:

```json
{
  "sampling": {
    "traces": 0.1,    // Sample 10% of standard healthy traces
    "requests": 0.1,  // Sample 10% of HTTP request transactions
    "errors": 1.0,    // 100% of errors are always captured
    "metrics": 1.0,   // Metrics are pre-aggregated in memory, 100% transmitted
    "routes": {
      "/health": { "traces": 0.0, "requests": 0.0 },       // Completely silence health checks
      "/metrics": { "traces": 0.0, "requests": 0.0 },      // Completely silence prometheus scrapes
      "/api/checkout": { "traces": 1.0, "requests": 1.0 }  // Always capture 100% of checkout traffic
    }
  }
}
```

> [!TIP]
> **Automatic Tail Retention**: Even when `traces` sampling is set to `0.1` (10%), the SDK automatically retains and transmits any trace that experiences an unhandled error or exceeds the slow-trace threshold (tail sampling).

### Cost Governor, Rate Limits & Metric Cardinality Caps

Protect against metric cardinality explosion and runaway billing:
* **Metric Cardinality Limit**: By default, metric instruments cap distinct attribute combinations at 2,000 unique series. High-cardinality values beyond the limit are collapsed into `[other]` to protect memory.
* **Tenant Governance**: In multi-tenant applications sending `x-tenant-id`, the SDK automatically bounds event ingestion per tenant (`quotaPerWindow: 1000` events per 60s window) with a reserved quota for critical fatal errors.

### Privacy & PII Scrubbing Toggles

Control what request data is captured or redacted:

```json
{
  "privacy": {
    "capture": {
      "headers": true,     // Attach sanitized request headers
      "body": false,       // Turn off body capture to eliminate payload parsing overhead
      "query": true,       // Attach URL query parameters
      "response": false,   // Disable response payload capture
      "cookies": false     // Drop cookie headers
    },
    "scrubbing": {
      "enabled": true,
      "headers": ["authorization", "cookie", "set-cookie", "x-api-key"],
      "fields": ["password", "token", "secret", "credit_card", "ssn", "cvv"]
    },
    "piiDetection": {
      "enabled": true,
      "maskEmails": true,  // Automatically masks user@domain.com
      "maskIPs": true      // Automatically masks IPv4 and IPv6 addresses
    }
  }
}
```

---

## 8. Remote Configuration Directives

Runtime telemetry policies (sampling rates, batch sizes, buffer thresholds, feature killswitches) are **centrally governed by the remote control plane (`POST /v1/init`)**, rather than hard-coded in customer applications.

Every 60 seconds, the SDK checks for remote configuration updates. When new directives arrive:
- **`sampling`**: Hot-swaps probabilistic sampling rates per event type and per route (e.g. `/health` sampled at `0.0`, `/checkout` sampled at `1.0`).
- **`killswitches`**: Instantly disables specific subsystems (`disableErrors`, `disableTracing`, `disableMetrics`, `disableLogs`, `disableCrons`).
- **`limits`**: Dynamically adjusts maximum batch sizes, maximum queue depths, and memory thresholds.
- **`privacy`**: Updates sensitive header redaction lists and regex PII rules.

---

## 9. Automatic Instrumentation

When imported, `@lynktrace/node` automatically intercepts standard Node.js libraries and database drivers without requiring manual code changes:

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

## 10. Complete API Reference by Domain

Every function below is exported directly from the package entry point:
```ts
import { ... } from '@lynktrace/node'
```

---

### A. Lifecycle, Serverless & Operational Health

#### `init(options?: SDKInitOptions): Promise<Readonly<RemoteConfigResponse> | undefined>`
Initializes the SDK, starts auto-instrumentation, and connects to the control plane.
- **Parameters**: `options?: SDKInitOptions` (see [Section 6](#6-initialization-init)).
- **Returns**: `Promise<Readonly<RemoteConfigResponse> | undefined>`. Never throws.

#### `wrapHandler(handler: ServerlessHandler, options?: ServerlessHandlerOptions): ServerlessHandler`
Wraps an AWS Lambda, Vercel, or Cloud Functions handler. Automatically configures `callbackWaitsForEmptyEventLoop = false`, captures unhandled errors, and flushes all pending in-memory telemetry over HTTP before the execution environment freezes.
- **Parameters**:
  - `handler`: `(event, context, callback?) => Promise<TResult> | TResult`
  - `options?: ServerlessHandlerOptions`:
    - `flushTimeoutMs?: number` (Default: `1500`ms)
    - `captureErrors?: boolean` (Default: `true`)
    - `callbackWaitsForEmptyEventLoop?: boolean` (Default: `true`)
- **Returns**: Wrapped serverless handler function.

```ts
import { wrapHandler } from '@lynktrace/node'

export const handler = wrapHandler(async (event, context) => {
  return { statusCode: 200, body: 'Success' }
})
```

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

#### `startProfile(profileId: string): Promise<boolean>`
Starts a CPU profiling session for the given `profileId`. Returns `true` if profiling started.

#### `stopProfile(profileId: string): Promise<void>`
Stops the CPU profiling session for `profileId` and queues the profile payload for transport.

---

### C. OpenTelemetry Metrics Instruments

All metric functions route into OpenTelemetry metric instruments and aggregate in memory with low CPU overhead.

```ts
import { incrementCounter, setGauge, recordHistogram, addUpDownCounter } from '@lynktrace/node'

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

#### `startSpan(name: string, options?: SpanOptions): LynkTraceSpan`
Starts an un-scoped OpenTelemetry span. The caller is responsible for calling `span.end()`.

#### `withSpan<T>(name: string, fn: (span: LynkTraceSpan) => Promise<T>, options?: SpanOptions): Promise<T>`
Executes an async callback within an active span. The span ends automatically upon promise resolution or rejection, with exceptions recorded.

```ts
const result = await withSpan('calculateTax', async (span) => {
  span.setAttribute('order.itemsCount', items.length)
  return computeTax(items)
})
```

#### `withSpanSync<T>(name: string, fn: (span: LynkTraceSpan) => T, options?: SpanOptions): T`
Synchronous version of `withSpan`. Automatically ends upon completion or throw.

#### `trace<T>(name: string, fn: (span: LynkTraceSpan) => T | Promise<T>, options?: SpanOptions): T | Promise<T>`
Ergonomic auto-detecting tracing function that transparently handles both synchronous and asynchronous callbacks.

#### `wrap<F>(name: string, fn: F, options?: SpanOptions): F`
Wraps a target function, returning an identical function signature that automatically creates an active span around each invocation.

```ts
const tracedCalculateTax = wrap('calculateTax', calculateTax)
```

#### `startBackgroundSpan(name: string, options?: BackgroundSpanOptions): LynkTraceSpan`
Starts a detached background span that survives after the parent HTTP server span has closed, causally linked via OpenTelemetry `SpanLink`.

#### `withBackgroundSpan<T>(name: string, fn: (span: LynkTraceSpan) => Promise<T>, options?: BackgroundSpanOptions): Promise<T>`
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

#### `startDbSpan(options: DbSpanOptions): LynkTraceSpan`
Starts an OpenTelemetry database span with semantic attributes (`db.system`, `db.name`, `db.statement`) and slow-query threshold tracking.

#### `withDbSpan<T>(options: DbSpanOptions, fn: (span: LynkTraceSpan) => Promise<T>): Promise<T>`
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

#### `withDbSpanSync<T>(options: DbSpanOptions, fn: (span: LynkTraceSpan) => T): T`
Synchronous version of `withDbSpan`.

#### `getActiveSpan(): LynkTraceSpan | undefined`
Returns the currently active OpenTelemetry span, or `undefined` if none is active.

#### `getActiveBackgroundSpanCount(): number`
Returns the count of currently in-flight background spans.

#### `flushTracer(): Promise<void>`
Flushes active OpenTelemetry `NodeTracerProvider` batch span processors.

#### `computeExclusiveDuration(spanIntervals: SpanInterval[], spanDurationMs: number): DurationBreakdown`
Calculates self-time vs child execution time across a tree of concurrent and sequential span intervals.

---

### G. Framework & Middleware Instrumentation

#### `lynktraceMiddleware(options?: LynkTraceExpressOptions): RequestHandler`
Express request monitoring middleware. Initializes `RequestContext` inside `AsyncLocalStorage`, extracts incoming W3C trace headers, enriches the active OpenTelemetry server span with route details, and emits transaction telemetry.
*(Formerly known as `monitorMiddleware` in early versions.)*

| Option | Type | Default | Description |
|---|---|---|---|
| `ignorePaths` | `readonly (string \| RegExp)[]` | `[]` | Exact/prefix paths or regular expressions to ignore (e.g. `['/health', /^\/static\/.*/]`). |
| `ignoreMethods` | `readonly string[]` | `[]` | Case-insensitive HTTP methods to skip (e.g. `['OPTIONS', 'HEAD']`). |
| `maxBreadcrumbs` | `number` | `100` | Maximum number of breadcrumbs stored in request-scoped storage. |
| `trustedProxies` | `readonly string[]` | `[]` | Trusted reverse proxy IPs used to extract real client IP from `X-Forwarded-For`. |
| `instrumentMiddleware` | `boolean` | `true` | When `true` (default), automatically measures execution durations of Express middleware layers. Set to `false` to opt out. |
| `minMiddlewareDurationMs` | `number` | `2.0` | Minimum execution duration in ms required for a middleware layer to emit a child span. |
| `ignoreMiddlewares` | `readonly (string \| RegExp)[]` | `['query', 'expressInit']` | Names of middleware layers to exclude from layer profiling. |

#### `expressErrorHandler(): ErrorRequestHandler`
Terminal Express error-handling middleware (`(err, req, res, next)`). Catches unhandled errors passed to `next(err)`, reports them via `captureException`, marks the active server span as `ERROR`, and passes the error to downstream custom handlers. Must be mounted after all application routes.

#### `instrumentExpress(app: Express, options?): void`
Profiles Express application middleware layers to measure execution duration without manually wrapping each layer.

#### `lynktraceFastifyPlugin(fastify: FastifyInstance, options?: LynkTraceFastifyOptions): Promise<void>`
Native Fastify plugin for request tracing, AsyncLocalStorage binding, and error capture.
*(Formerly known as `fastifyLynkTracePlugin` in early versions.)*

---

### H. Driver Instrumentation Factories & Helpers

- **`registerBootstrapAutoInstrumentations()`**: Automatically executed on import. Registers fail-safe monkey-patch hooks for 15 supported drivers.
- **`registerAutoInstrumentations(options?: AutoInstrumentOptions)`**: Programmatically registers or reconfigures auto-instrumentation drivers with custom driver options.
- **`registerEsmLoaderHooks()`**: Registers Node.js ESM module resolution customization hooks for zero-code `--import @lynktrace/node/register`.
- **`createGraphQLInstrumentation(options?)`**: Creates GraphQL resolver tracing instrumentation.
- **`createPrismaInstrumentation(options?)`**: Creates OpenTelemetry instrumentation for Prisma.
- **`lynktracePrismaExtension(options?)`**: Returns a `$extends` client extension for Prisma queries.
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

### J. Canonical `LynkTrace` Facade Object

All primary SDK methods are also accessible directly via the `LynkTrace` facade object (legacy alias `Pulse` is also exported for backward compatibility):

```ts
import { LynkTrace } from '@lynktrace/node'
// or: import LynkTrace from '@lynktrace/node'
// legacy: import { Pulse } from '@lynktrace/node'

await LynkTrace.init({ apiKey: process.env.LYNKTRACE_API_KEY! })

app.use(LynkTrace.lynktraceMiddleware({ instrumentMiddleware: true }))
app.use(LynkTrace.expressErrorHandler())

LynkTrace.captureException(new Error('Something broke'))
LynkTrace.captureMessage('Order placed', 'info')
LynkTrace.captureMetric('cache.miss', 1)
LynkTrace.incrementCounter('orders.total')
LynkTrace.setGauge('active.connections', 8)
LynkTrace.recordHistogram('render.time', 12.4)
LynkTrace.addBreadcrumb({ category: 'cart', message: 'Item added' })
LynkTrace.setUser({ id: 'user_1' })
LynkTrace.setTag('tenant', 'acme')

await LynkTrace.withSpan('processPayment', async (span) => { ... })
await LynkTrace.withBackgroundSpan('emailReceipt', async (span) => { ... })
await LynkTrace.withDbSpan({ system: 'postgresql' }, async () => { ... })

const traceId = LynkTrace.getTraceId()
const health = LynkTrace.getHealth()

await LynkTrace.flush()
await LynkTrace.shutdown()
```

---

---

## 11. Server & Runtime Deployment Guides

`@lynktrace/node` is engineered to run seamlessly across all major Node.js deployment targets. Below are complete production guides for each runtime.

### Express.js Deep Dive

Mount `lynktraceMiddleware` at the top of your middleware chain and `expressErrorHandler` at the very end of your route declarations:

```ts
import express from 'express'
import { init, lynktraceMiddleware, expressErrorHandler } from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'express-api',
})

const app = express()

// 1. Mount lynktraceMiddleware at the very top:
app.use(lynktraceMiddleware({
  // Filter out health checks and internal endpoints
  ignorePaths: ['/health', '/metrics', /^\/assets\/.*/],
  // Ignore preflight options
  ignoreMethods: ['OPTIONS', 'HEAD'],
  // Enable layer profiling to detect slow middleware
  instrumentMiddleware: true,
  minMiddlewareDurationMs: 2.0,
  // Trusted proxy IPs for X-Forwarded-For resolution
  trustedProxies: ['127.0.0.1', '10.0.0.1'],
}))

app.use(express.json())

app.get('/api/users/:id', async (req, res) => {
  res.json({ id: req.params.id })
})

// 2. Terminal error handler mounted after all routes:
app.use(expressErrorHandler())

app.listen(3000)
```

### Fastify Deep Dive

Fastify uses asynchronous hooks for lifecycle tracing. Register `lynktraceFastifyPlugin`:

```ts
import Fastify from 'fastify'
import { init, lynktraceFastifyPlugin } from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'fastify-api',
})

const fastify = Fastify()

await fastify.register(lynktraceFastifyPlugin, {
  ignorePaths: ['/health', '/metrics'],
  ignoreMethods: ['OPTIONS'],
  maxBreadcrumbs: 100,
  captureHeaders: true,
})

fastify.get('/api/users', async () => ({ users: [] }))

await fastify.listen({ port: 3000, host: '0.0.0.0' })
```

### Serverless & Cloud Functions Deep Dive (AWS Lambda, Vercel, GCP)

Serverless execution environments present unique challenges that standard APM SDKs fail to handle:
1. **Hypervisor CPU Freeze**: As soon as a serverless function returns a response, the cloud hypervisor instantly freezes CPU execution. Background flush timers (`setInterval`) will never execute until a future request (or will be terminated if the container is recycled).
2. **Read-Only Filesystems**: Cloud runtimes typically mount root directories (`/var/task`, `/root`) as read-only (`EROFS`).

#### How `@lynktrace/node` solves Serverless:
* **`wrapHandler`**: Automatically sets `context.callbackWaitsForEmptyEventLoop = false` so background handles do not hang the Lambda runtime.
* **Synchronous In-Memory Flush**: Upon handler return or unhandled error, `wrapHandler` synchronously flushes all captured traces, metrics, and errors over HTTP before the container freezes.
* **Read-Only / Diskless Fallback**: The SDK automatically detects serverless environments (`AWS_LAMBDA_FUNCTION_NAME`, `VERCEL`, `K_SERVICE`, etc.) and redirects fallback paths to `os.tmpdir()` (`/tmp`). If disk access is completely blocked (`EROFS`/`EACCES`), the SDK degrades gracefully to **pure in-memory mode** without throwing errors or crashing.

#### Production AWS Lambda Example:

```ts
import { init, wrapHandler, captureException } from '@lynktrace/node'

// Initialize during container cold start:
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'payment-webhook-lambda',
  // Disable disk storage since serverless is stateless:
  offlineQueue: false,
  // Disable SIGTERM/SIGINT listeners:
  handleSignals: false,
})

export const handler = wrapHandler(async (event: any, context: any) => {
  const body = JSON.parse(event.body || '{}')
  
  if (!body.paymentId) {
    const err = new Error('Missing paymentId')
    captureException(err)
    return { statusCode: 400, body: JSON.stringify({ error: err.message }) }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ status: 'success', paymentId: body.paymentId }),
  }
}, {
  flushTimeoutMs: 1500, // Maximum ms to wait for telemetry HTTP transmission
  captureErrors: true,  // Automatically capture and report uncaught exceptions
})
```

#### Vercel Serverless / Next.js API Route Example:

```ts
// pages/api/checkout.ts or app/api/checkout/route.ts
import { init, wrapHandler } from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'nextjs-web',
  offlineQueue: false,
})

export default wrapHandler(async (req: any, res: any) => {
  res.status(200).json({ ok: true })
})
```

### NestJS Deep Dive

NestJS applications can use `lynktraceMiddleware` for incoming request tracing, combined with an `@Catch()` Exception Filter for application-level error tracking:

```ts
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { init, lynktraceMiddleware, captureException } from '@lynktrace/node'
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Injectable,
  NestMiddleware,
} from '@nestjs/common'
import { Request, Response, NextFunction } from 'express'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'nest-service',
})

// 1. NestJS Global Exception Filter
@Catch()
export class LynkTraceExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR

    // Capture 5xx server errors to LynkTrace
    if (status >= 500) {
      captureException(exception)
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
    })
  }
}

// 2. NestJS Middleware Wrapper
@Injectable()
export class LynkTraceHttpMiddleware implements NestMiddleware {
  private readonly handler = lynktraceMiddleware({ instrumentMiddleware: true })
  use(req: Request, res: Response, next: NextFunction) {
    this.handler(req, res, next)
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.use(lynktraceMiddleware({ instrumentMiddleware: true }))
  app.useGlobalFilters(new LynkTraceExceptionsFilter())
  await app.listen(3000)
}
bootstrap()
```

### Native Node.js HTTP / HTTPS

For applications using Node's standard `http` or `https` modules without a web framework:

```ts
import http from 'node:http'
import { init, captureRequest, captureException, flush } from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'raw-http-server',
})

const server = http.createServer(async (req, res) => {
  const startTime = Date.now()
  try {
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pong: true }))
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  } catch (err) {
    captureException(err)
    res.writeHead(500)
    res.end('Server Error')
  } finally {
    // Record request transaction
    captureRequest({
      type: 'request',
      method: req.method || 'GET',
      url: req.url || '/',
      statusCode: res.statusCode,
      latency: Date.now() - startTime,
      timestamp: startTime,
    })
  }
})

server.listen(3000)
```

### Background Job Processors & Queues

When processing jobs in BullMQ, Agenda, or batch worker processes, wrap job execution in `withBackgroundSpan`:

```ts
import { init, withBackgroundSpan, captureException } from '@lynktrace/node'
import { Worker } from 'bullmq'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'queue-worker',
})

const worker = new Worker('pdf-generation', async (job) => {
  return await withBackgroundSpan(`job:${job.name}`, async (span) => {
    span.setAttribute('bullmq.job.id', job.id!)
    span.setAttribute('bullmq.queue', job.queueName)
    try {
      return await generateInvoicePdf(job.data)
    } catch (err) {
      captureException(err)
      throw err
    }
  })
})
```

---

## 12. Database Instrumentation & Slow Query Tagging

LynkTrace provides semantic database tracing with automatic slow query tagging:

```ts
import { withDbSpan } from '@lynktrace/node'

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
import { captureCronCheckIn } from '@lynktrace/node'

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

If the host application loses internet connectivity, events are persisted to a local disk queue (`~/.lynktrace/events`) with SQLite/file backup. Upon reconnection, replayed events are automatically transmitted without duplicate delivery.

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
import { shutdown, emergencyFlush } from '@lynktrace/node'

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

1. **Preload the SDK via `--import`**: Always run `node --import @lynktrace/node/register dist/server.js`.
2. **Never Hardcode API Keys**: Load `LYNKTRACE_API_KEY` from environment variables or secrets managers.
3. **Always Mount `expressErrorHandler`**: Place it after all routes to capture unhandled promise rejections.
4. **Use `withBackgroundSpan` for Post-Response Work**: Never attach asynchronous tasks directly to the closed HTTP request trace.
5. **Set Realistic Shutdown Budgets**: Set `shutdownTimeoutMs` in accordance with your container termination grace period (e.g. 5–10 seconds).

---

## 19. Common Integration Mistakes

```
❌ INCORRECT: Initializing SDK after importing Express or database drivers
import express from 'express'
import { Pool } from 'pg'
import { init } from '@lynktrace/node'
await init() // Too late! Drivers are already loaded without hooks.

✅ CORRECT: Initialize LynkTrace before importing application drivers (or use --import)
import { init } from '@lynktrace/node'
await init({ apiKey: process.env.LYNKTRACE_API_KEY! })
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
- **Check API Key**: Verify `LYNKTRACE_API_KEY` is present and does not contain whitespace or control characters.
- **Check Backend Connectivity**: Ensure the host can reach `LYNKTRACE_ENDPOINT` (`curl -I https://api.lynktrace.com/v1/init`).
- **Inspect Diagnostics**: Run with `LYNKTRACE_SDK_CONSOLE_DEBUG=true` to view raw connection messages.

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
| **`lynktraceMiddleware`** | `monitorMiddleware` | Express request monitoring middleware |
| **`expressErrorHandler`** | *(new)* | Express terminal error-handling middleware |
| **`lynktraceFastifyPlugin`** | `fastifyLynkTracePlugin` | Fastify request monitoring plugin |
| **`captureException`** | `captureError` | Error & exception reporting |
| **`emergencyFlush`** | `crashFlush` | Synchronous emergency flush on process crash |
| **`getHealth`** | `getSDKHealth` | SDK operational diagnostics snapshot |

---

## License

ISC © LynkTrace APM Team
