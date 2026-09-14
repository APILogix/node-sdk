# @pulse-apm/node

> Enterprise-grade observability and distributed tracing SDK for Node.js applications, built on OpenTelemetry with automated database interception, truthful timing attribution, adaptive sampling, and detached background execution support.

[![Version](https://img.shields.io/badge/version-8.3.12-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-459%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18.19.0-green.svg)]()
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](package.json)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [SDK Initialization & Startup](#sdk-initialization--startup)
  - [Passing Your API Key](#passing-your-api-key)
  - [1. ECMAScript Modules (ESM) — Recommended](#1-ecmascript-modules-esm--recommended)
  - [2. CommonJS (CJS)](#2-commonjs-cjs)
- [Environment & Endpoint Configuration (.env)](#environment--endpoint-configuration-env)
- [High-Throughput Services & Adaptive Sampling](#high-throughput-services--adaptive-sampling)
- [Ultra-Fast Initialization Latency](#ultra-fast-initialization-latency)
- [Framework Integration](#framework-integration)
  - [Express.js Integration](#expressjs-integration)
    - [Express ESM Example](#express-esm-example)
    - [Express CommonJS Example](#express-commonjs-example)
  - [Fastify Integration](#fastify-integration)
- [Database & Cache Auto-Instrumentation](#database--cache-auto-instrumentation)
- [Custom Function & Business Logic Tracing](#custom-function--business-logic-tracing)
  - [In-Request Function Tracing (`withSpan`)](#in-request-function-tracing-withspan)
  - [Synchronous Function Tracing (`withSpanSync`)](#synchronous-function-tracing-withspansync)
- [Detached Background Work (`withBackgroundSpan`)](#detached-background-work-withbackgroundspan)
- [Custom Database Spans (`withDbSpan`)](#custom-database-spans-withdbspan)
- [Error Tracking & Context Enrichment](#error-tracking--context-enrichment)
  - [Explicit Error Capture (`captureError`)](#explicit-error-capture-captureerror)
  - [Breadcrumbs, User Identity & Tags](#breadcrumbs-user-identity--tags)
- [Custom Metrics Tracking](#custom-metrics-tracking)
- [Lifecycle & Hardened Graceful Shutdown](#lifecycle--hardened-graceful-shutdown)
- [Resilient Pipeline & Telemetry Integrity](#resilient-pipeline--telemetry-integrity)
- [API Reference](#api-reference)
- [License](#license)

---

## Features

- **Turnkey Auto-Instrumentation**: Automatically instruments HTTP/HTTPS, Express, Fastify, PostgreSQL (`pg`), Redis (`redis`, `ioredis`), MongoDB, MySQL2, Prisma, BullMQ, Axios, Undici, and `fetch`.
- **Truthful Timing & Exclusive Durations**: Zero synthetic duration clamping. High-resolution monotonic interval calculation separates Node.js CPU execution time from database and network wait time.
- **Detached Background Traces**: First-class support for post-response asynchronous tasks (emails, webhooks, queue publish) via causal `SpanLink` without leaking HTTP trace memory.
- **Dynamic Adaptive Sampling**: Scales non-error trace volume dynamically under system pressure (`CRITICAL`: 10%, `PRESSURED`: 50%, `ELEVATED`: 80%) to optimize ingestion costs in high-throughput services (>10,000 RPS) while **guaranteeing 100% error preservation**.
- **Zero-Dependency Native `.env` Discovery**: Automatically loads your host project's `.env` for endpoint and control-plane configuration without external dependencies.
- **Ultra-Fast Sub-10ms Startup**: Bypasses IPv6 DNS resolution fallback delays with automatic origin normalization, HTTP keep-alive, and Redis lookup cache alignment.
- **Resilient Pipeline & Orphan Recovery**: Cycle-safe bounded orphan recovery grafts unvisited child subtrees onto root traces; LRU trace deduplication stops duplicate emissions; startup index noise is suppressed.
- **Deep Recursive PII Sanitization**: Masks credit card numbers, passwords, JWTs, JSON string attributes, URL basic authentication credentials, and `set-cookie` headers.
- **Hardened Graceful Shutdown**: Automatic `SIGTERM`/`SIGINT` listeners drain in-flight batches across all transport routes before container termination.

---

## Installation

```bash
npm install @pulse-apm/node
```

> **Requirements:** Node.js `>= 18.19.0` (or Node.js `>= 20.6.0` for native ESM `--import` and native `loadEnvFile` support).

---

## SDK Initialization & Startup

Always initialize the SDK **as early as possible** in your application lifecycle, before importing database drivers or starting your HTTP server.

### Passing Your API Key

When calling `init()`, you must pass your Pulse APM **`apiKey`**. You can provide it as an options object (recommended) or as a shorthand string:

```typescript
import { init } from '@pulse-apm/node'

// Option A: Options object (Recommended)
await init({
  apiKey: 'pls_live_your_api_key_here',
})

// Option B: Shorthand string
await init('pls_live_your_api_key_here')

// Option C: Passing from process.env
await init({
  apiKey: process.env.PULSE_API_KEY!,
})
```

The SDK automatically reads your `package.json` to detect `applicationName` and `applicationVersion`. Runtime telemetry policy, sampling rates, features, and entitlements are authoritatively managed via remote configuration.

---

### 1. ECMAScript Modules (ESM) — Recommended

If your project uses `"type": "module"` in `package.json`:

#### Step 1: Preload the ESM Loader Hook
To ensure static `import pg from 'pg'` and `import redis from 'redis'` are automatically intercepted before execution, launch Node with the `--import` flag:

```bash
# Development / Production command
node --import @pulse-apm/node/register server.js
```

> **Why?** Node.js evaluates static ESM imports before executing module code. The `--import` flag registers synchronous `import-in-the-middle` hooks into the module loader, guaranteeing database and HTTP drivers are automatically wrapped without code changes.

#### Step 2: Initialize in Code

```typescript
// server.js or app.ts
import { init } from '@pulse-apm/node'

// Initialize the SDK before starting your server (pass your apiKey)
await init({
  apiKey: process.env.PULSE_API_KEY || 'pls_live_your_api_key_here',
})

// Import frameworks and database drivers AFTER initialization
import express from 'express'
import pg from 'pg'

const app = express()
// ... continue setting up your app
```

> 📖 **Need architectural recipes for NestJS, Fastify, BullMQ, TypeScript, or Docker?**  
> Check out the [Complete Initialization & Load-Order Guide](docs/INITIALIZATION_GUIDE.md).

---

### 2. CommonJS (CJS)

If your project uses standard CommonJS (`require`):

```javascript
// server.js
const { init } = require('@pulse-apm/node')

async function bootstrap() {
  // 1. Initialize the SDK with apiKey
  await init({
    apiKey: process.env.PULSE_API_KEY || 'pls_live_your_api_key_here',
  })

  // 2. Require frameworks and database drivers AFTER initialization
  const express = require('express')
  const { Pool } = require('pg')

  const app = express()
  // ... continue setting up your app
}

bootstrap().catch(console.error)
```

Run with standard Node:
```bash
node server.js
```

---

## Environment & Endpoint Configuration (.env)

The SDK features a **zero-dependency native `.env` loader**. It automatically inspects your application's root directory (`process.cwd()`) and loads environment variables using Node.js native `process.loadEnvFile()` (Node 20.6+) or a lightweight fallback parser.

You do **not** need to install or import `dotenv` to configure your backend ingestion endpoint.

### Configuring Your Ingest Endpoint in `.env`

Create a `.env` file in the root of your host project:

```env
# Custom backend ingestion / control plane endpoint
PULSE_ENDPOINT=http://127.0.0.1:3000
```

### Precedence Resolution

The SDK resolves your backend ingestion endpoint using the following order of precedence:

1. `endpoint` option passed to `init({ apiKey, endpoint: '...' })`
2. `PULSE_ENDPOINT` environment variable (from `.env` or system)
3. `PULSE_API_URL` environment variable
4. `PULSE_BASE_URL` environment variable
5. `BACKEND_URL` environment variable
6. `SDK_BASE_URL` environment variable
7. Default production origin (`http://127.0.0.1:5000`)

---

## High-Throughput Services & Adaptive Sampling

In services handling high throughput (>10,000 RPS), static trace sampling can result in high telemetry ingestion costs and risk event-loop lag during sudden traffic spikes.

To optimize ingestion volume while safeguarding system performance, enable **Adaptive Sampling**:

```typescript
import { init } from '@pulse-apm/node'

await init({
  apiKey: process.env.PULSE_API_KEY!,
  adaptiveSampling: true, // Enables dynamic system pressure scaling
})
```

### How Adaptive Sampling Works:
* Continuously evaluates system pressure (`adaptivePressure`) by monitoring heap memory utilization and event-loop lag:
  * **`HEALTHY`**: Retains 100% of the remotely configured sample rate.
  * **`ELEVATED`**: Dynamically throttles non-error telemetry to at most **80%** of the configured rate.
  * **`PRESSURED`**: Dynamically throttles non-error telemetry to at most **50%** of the configured rate.
  * **`CRITICAL`**: Dynamically throttles non-error telemetry to at most **10%** of the configured rate (`reason: 'adaptive_pressure'`).
* **Non-Negotiable Error Guarantee**: Errors (`eventType === 'errors'`) are **100% exempt** from adaptive reduction. Even under `CRITICAL` memory/lag pressure, 100% of errors are captured and dispatched.

---

## Ultra-Fast Initialization Latency

SDK startup is engineered for sub-millisecond to sub-10ms execution:
* **IPv6 DNS Bypass**: When communicating with local endpoints (`localhost`), Node.js `fetch` (Undici) resolves IPv6 `::1` before falling back to `127.0.0.1`, which can induce a 1–3 second OS timeout. The SDK automatically normalizes `localhost` to `127.0.0.1`, eliminating DNS lookup lag.
* **HTTP Keep-Alive**: All control-plane handshakes reuse TCP connections with `Connection: keep-alive`.
* **Redis Cache Alignment**: The `/v1/init` payload structure is aligned with the backend's Redis lookup caching (`getApiKeyMapping` + `getInitDelivery`), ensuring sub-millisecond responses on cache hits.

---

## Framework Integration

### Express.js Integration

To capture incoming HTTP requests, route parameters, response status codes, payload sizes, and correlate errors, mount `monitorMiddleware()` early in your middleware chain and `expressErrorHandler()` after all routes.

#### Express ESM Example

```typescript
import { init, monitorMiddleware, expressErrorHandler } from '@pulse-apm/node'
import express from 'express'
import pg from 'pg'

// 1. Initialize SDK with your apiKey
await init({ apiKey: process.env.PULSE_API_KEY! })

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = express()

// 2. Parse bodies before monitorMiddleware
app.use(express.json())

// 3. Mount monitorMiddleware before any routes
app.use(monitorMiddleware())

// 4. Standard route handlers — database queries are automatically traced as child spans!
app.get('/api/users/:id', async (req, res) => {
  // PostgreSQL query is automatically intercepted and linked to this HTTP request trace:
  const result = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.params.id])
  
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' })
  }

  res.json({ user: result.rows[0] })
})

// 5. Mount expressErrorHandler after all routes
app.use(expressErrorHandler())

app.listen(3000, () => {
  console.log('Server running on port 3000')
})
```

#### Express CommonJS Example

```javascript
const { init, monitorMiddleware, expressErrorHandler } = require('@pulse-apm/node')
const express = require('express')
const { Pool } = require('pg')

async function main() {
  await init({ apiKey: process.env.PULSE_API_KEY })

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = express()

  app.use(express.json())
  app.use(monitorMiddleware())

  app.get('/api/orders/:id', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id])
    res.json({ order: rows[0] })
  })

  // Error handling middleware
  app.use(expressErrorHandler())

  app.listen(3000, () => {
    console.log('Server listening on port 3000')
  })
}

main().catch(console.error)
```

---

### Fastify Integration

Fastify applications use `fastifyPulsePlugin`:

```typescript
import { init, fastifyPulsePlugin } from '@pulse-apm/node'
import Fastify from 'fastify'

await init({ apiKey: process.env.PULSE_API_KEY! })

const fastify = Fastify({ logger: true })

// Register the Pulse plugin
await fastify.register(fastifyPulsePlugin)

fastify.get('/api/health', async (request, reply) => {
  return { status: 'healthy' }
})

await fastify.listen({ port: 3000 })
```

---

## Database & Cache Auto-Instrumentation

When auto-instrumentation is enabled, you **do not need to write manual spans** for database queries. The SDK automatically intercepts:

| Technology | Supported Clients | What is Captured |
|---|---|---|
| **PostgreSQL** | `pg`, `pg-pool` | Sanitized SQL (`db.statement`), table, query latency, errors |
| **Redis** | `redis` (v4+), `ioredis` (v4, v5) | Command name, sanitized key, pipelining, multi/exec blocks |
| **MongoDB** | `mongodb` (v4, v5, v6), `mongoose` | Collection, operation (`find`, `update`), latency |
| **MySQL** | `mysql2` | Sanitized SQL, query latency, connection pool events |
| **Prisma** | `@prisma/client` | Query engine operations, query latency |
| **HTTP Clients**| `axios`, native `http`/`https`, `fetch`, `undici` | Outgoing URL, status code, latency, W3C headers injected |

In every request trace, the SDK automatically presents:
1. **Total query count** (e.g. 4 PostgreSQL queries + 2 Redis commands).
2. **Exact execution time of each query** (e.g. `SELECT users`: 12.4ms).
3. **Internal Node.js execution time** (computed via `exclusiveDuration`, separating CPU execution from database wait time).

---

## Custom Function & Business Logic Tracing

Use `withSpan` to track custom business logic, external API integrations, or computationally expensive algorithms within the current request context.

### In-Request Function Tracing (`withSpan`)

Spans created with `withSpan` automatically nest as children under the current active HTTP request.

```typescript
import { withSpan } from '@pulse-apm/node'

export async function processPayment(orderId: string, amount: number) {
  return await withSpan('payments.process', async (span) => {
    // 1. Add searchable attributes
    span.setAttribute('payment.order_id', orderId)
    span.setAttribute('payment.amount', amount)
    span.setAttribute('payment.currency', 'USD')

    // 2. Perform business logic
    const gatewayResponse = await callPaymentGateway(orderId, amount)

    // 3. Set span status
    if (gatewayResponse.success) {
      span.setStatus('ok')
      span.setAttribute('payment.transaction_id', gatewayResponse.txnId)
      return gatewayResponse
    } else {
      span.setStatus('error', gatewayResponse.declineReason)
      throw new Error(`Payment declined: ${gatewayResponse.declineReason}`)
    }
  })
}
```

### Synchronous Function Tracing (`withSpanSync`)

For non-async functions:

```typescript
import { withSpanSync } from '@pulse-apm/node'

const token = withSpanSync('crypto.generateToken', (span) => {
  span.setAttribute('crypto.algorithm', 'sha256')
  return computeHash(secret)
})
```

---

## Detached Background Work (`withBackgroundSpan`)

When tasks execute *after* an HTTP response has completed (such as sending confirmation emails, generating PDF receipts, or publishing events to a message queue), using standard spans risks memory leaks or corrupted parent-child trees.

`withBackgroundSpan` creates an independent, detached trace root linked via a causal W3C `SpanLink`:

```typescript
import { withBackgroundSpan } from '@pulse-apm/node'

app.post('/api/checkout', async (req, res) => {
  const order = await createOrder(req.body)

  // Respond to the user immediately:
  res.status(201).json({ orderId: order.id })

  // Execute detached background task asynchronously:
  withBackgroundSpan('checkout.send_email', { timeoutMs: 10000 }, async (span) => {
    span.setAttribute('order.id', order.id)
    await emailClient.sendReceipt(order.email, order)
  })
})
```

---

## Custom Database Spans (`withDbSpan`)

If you use custom database drivers or raw connection pools:

```typescript
import { withDbSpan } from '@pulse-apm/node'

const users = await withDbSpan('postgresql', 'SELECT', async (span) => {
  span.setAttribute('db.sql.table', 'users')
  return await rawPool.query('SELECT * FROM users')
})
```

---

## Error Tracking & Context Enrichment

### Explicit Error Capture (`captureError`)

Catch and record exceptions with enriched diagnostics:

```typescript
import { captureError } from '@pulse-apm/node'

try {
  await chargeCard(token)
} catch (err) {
  captureError(err, {
    tags: { gateway: 'stripe' },
    extra: { attempt: 3 },
    mechanism: 'payment_flow',
  })
  throw err
}
```

### Breadcrumbs, User Identity & Tags

Add diagnostic breadcrumbs that are attached to any subsequent error or trace:

```typescript
import { addBreadcrumb, setUser, setTag, setExtra } from '@pulse-apm/node'

// In an authentication middleware or handler:
setUser({
  id: 'usr_10293',
  email: 'dev@company.com',
  tenantId: 'tenant_acme_corp',
})

// Add breadcrumbs describing steps leading up to an action:
addBreadcrumb({
  category: 'auth',
  message: 'User completed 2FA challenge',
  level: 'info',
  data: { method: 'totp' },
})

setTag('environment.region', 'us-east-1')
setExtra('cart_items_count', 4)
```

---

## Custom Metrics Tracking

The SDK includes a high-performance OpenTelemetry metrics client:

```typescript
import { incrementCounter, recordHistogram, setGauge } from '@pulse-apm/node'

// 1. Counters
incrementCounter('orders.created', 1, {
  payment_method: 'credit_card',
  plan: 'enterprise',
})

// 2. Histograms (latencies, sizes)
recordHistogram('checkout.processing_time_ms', 142.5, {
  currency: 'USD',
})

// 3. Gauges (active connections, memory)
setGauge('worker.active_jobs', 12)
```

---

## Lifecycle & Hardened Graceful Shutdown

In containerized environments (Kubernetes, Docker, AWS ECS), ensure pending spans, traces, and metrics are flushed before container termination.

### Automatic Signal Handling (Default)

By default (`handleSignals: true`), `init()` automatically registers listeners for `SIGTERM` and `SIGINT`. When your container orchestrator signals termination, the SDK:
1. Rejects incoming non-critical telemetry to freeze buffer sizes.
2. Flushes the trace aggregator, orphan-recovered span trees, and active span buffers.
3. Concurrently drains in-flight batches across all transport routes (`traces`, `spans`, `requests`, `metrics`, `errors`).
4. Unreferences remaining background timers, allowing the Node process to exit cleanly without hanging.

### Manual Shutdown Control

If you prefer to manage signal handlers yourself, set `handleSignals: false` and call `await shutdown()`:

```typescript
import { init, shutdown } from '@pulse-apm/node'

await init({
  apiKey: process.env.PULSE_API_KEY!,
  handleSignals: false, // Set false when managing termination manually
})

async function onSignal() {
  console.log('Received termination signal. Draining telemetry batches...')
  
  // Drains in-flight batches before exit
  await shutdown(2000) // 2000ms deadline
  
  process.exit(0)
}

process.on('SIGTERM', onSignal)
process.on('SIGINT', onSignal)
```

---

## Resilient Pipeline & Telemetry Integrity

The SDK includes several enterprise pipeline protections:
- **Cycle-Safe Bounded Orphan Recovery**: Spans with delayed or missing intermediate parents are safely grafted onto the trace root with duration re-clamping, ensuring **zero missing database or HTTP spans in waterfalls**.
- **Process Warning Routing**: Node runtime warnings (`[DEP0123] Warning: ...`) and driver deprecation notices in `console.error` are routed to `captureMessage(..., Severity.Warning)` instead of generating false APM error incidents, keeping HTTP 200 transactions clean.
- **Trace Deduplication**: A 60-second sliding LRU cache drops duplicate trace payloads during network retry storms.
- **MongoDB Startup Suppression**: Mongoose index/build commands at startup outside an active request context are suppressed, saving ingest quotas.
- **Recursive Sensitive Data Scrubbing**: Recursively scrubs JSON strings, URLs with basic authentication credentials, query-parameter tokens, and `set-cookie` headers.

---

## API Reference

| Function / Export | Purpose | Common Usage |
|---|---|---|
| `init(options)` | Standard process-level SDK initialization function. | `await init({ apiKey: '...' })` or `await init('...')` |
| `monitorMiddleware(options)` | Express request & context monitoring middleware. | `app.use(monitorMiddleware())` |
| `expressErrorHandler()` | Express error capture middleware. | `app.use(expressErrorHandler())` |
| `fastifyPulsePlugin` | Fastify request monitoring plugin. | `await fastify.register(fastifyPulsePlugin)` |
| `withSpan(name, fn, options)` | Executes an async function within a child span. | `await withSpan('calc', async (span) => ...)` |
| `withSpanSync(name, fn, options)` | Executes a sync function within a child span. | `withSpanSync('parse', (span) => ...)` |
| `withBackgroundSpan(name, options, fn)` | Detached post-response task with causal `SpanLink`. | `withBackgroundSpan('email', { timeoutMs }, fn)` |
| `withDbSpan(system, op, fn, options)` | Manual database query span helper. | `await withDbSpan('postgresql', 'SELECT', fn)` |
| `captureError(err, context)` | Authoritative error recording API. | `captureError(new Error('...'))` |
| `addBreadcrumb(crumb)` | Appends a diagnostic breadcrumb to current context. | `addBreadcrumb({ message: 'step 1' })` |
| `setUser(user)` | Associates user identity with request and errors. | `setUser({ id: '123' })` |
| `incrementCounter(name, value, tags)` | Emits an OTel metric counter. | `incrementCounter('logins', 1)` |
| `recordHistogram(name, value, tags)` | Emits a histogram distribution value. | `recordHistogram('size', 1024)` |
| `flush(timeoutMs)` | Force-flushes in-flight spans and events. | `await flush(1000)` |
| `shutdown(timeoutMs)` | Drains telemetry and cleanly releases resources. | `await shutdown(2000)` |

### `init()` Options Reference (3-Tier Enterprise Structure)

In enterprise architectures, **runtime telemetry policy** (sampling rates, kill switches, PII blacklists, transport batching) is centrally governed by the remote control plane. Options passed to `init()` strictly control **local process-level integration concerns**.

```typescript
import { init } from '@pulse-apm/node'

// ─── TIER 1: Core Configuration (Standard Production Usage) ─────────────────
await init({
  apiKey: 'pls_live_abcdef1234567890', // Required: Project authentication key
})

// ─── TIER 2: Infrastructure & Lifecycle (DevOps, K8s & High-Throughput) ────
await init({
  apiKey: 'pls_live_abcdef1234567890',
  endpoint: 'http://internal-collector.corp:3000', // Custom VPC forward-proxy / backend origin
  adaptiveSampling: true,                          // Dynamic rate scaling under load (>10k RPS)
  handleSignals: true,                             // Intercept SIGTERM/SIGINT for container drain (default: true)
  initTimeoutMs: 1500,                             // Fail-open startup deadline (default: 1500ms)
  shutdownTimeoutMs: 5000,                         // Maximum container termination drain window (default: 5000ms)
})

// ─── TIER 3: Pipeline & Compliance Hooks (InfoSec & Framework Authors) ──────
await init({
  apiKey: 'pls_live_abcdef1234567890',
  beforeSend: (event) => {
    // Custom payload transformation or emergency redaction before export
    return event
  },
  beforeBreadcrumb: (crumb) => {
    // Custom breadcrumb filtering
    return crumb
  },
  sourceMaps: {
    paths: ['./dist'],                             // Container filesystem path to source maps
    allowRemote: false,
  },
  maxBreadcrumbs: 100,                             // Memory heap buffer limit (default: 100)
  debug: false,                                    // Diagnostic logging to stdout (default: false)
  logLevel: 'info',                                // Diagnostic severity ('debug' | 'info' | 'warning' | 'error')
})
```

#### Why are `sampleRate`, `enableTracing`, and `dataScrubbing` absent from `init()`?
Enterprise environments operate dozens or hundreds of microservices. Changing a sampling rate during an incident, enabling a kill switch, or updating a redacted PII field must **never require a code commit, CI/CD pipeline run, or pod redeployment**. The SDK synchronizes these policies dynamically via the Pulse remote control plane.

---

## License

ISC © Pulse APM
