# @pulse-apm/node

> Enterprise-grade observability and distributed tracing SDK for Node.js applications, built on OpenTelemetry with automated database interception, truthful timing attribution, and detached background execution support.

[![Version](https://img.shields.io/badge/version-8.1.0-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-415%20passing-brightgreen.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18.19.0-green.svg)]()
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](package.json)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [SDK Initialization & Startup](#sdk-initialization--startup)
  - [1. ECMAScript Modules (ESM) — Recommended](#1-ecmascript-modules-esm--recommended)
  - [2. CommonJS (CJS)](#2-commonjs-cjs)
- [Framework Integration](#framework-integration)
  - [Express.js Integration](#expressjs-integration)
    - [ESM Example](#express-esm-example)
    - [CommonJS Example](#express-commonjs-example)
  - [Fastify Integration](#fastify-integration)
- [Database & Cache Auto-Instrumentation](#database--cache-auto-instrumentation)
- [Custom Function & Business Logic Tracing](#custom-function--business-logic-tracing)
  - [In-Request Function Tracing (`withSpan`)](#in-request-function-tracing-withspan)
    - [ESM Example](#withspan-esm-example)
    - [CommonJS Example](#withspan-commonjs-example)
  - [Synchronous Function Tracing (`withSpanSync`)](#synchronous-function-tracing-withspansync)
- [Detached Background Work (`withBackgroundSpan`)](#detached-background-work-withbackgroundspan)
  - [When to Use `withBackgroundSpan` vs `withSpan`](#when-to-use-withbackgroundspan-vs-withspan)
  - [ESM Example](#withbackgroundspan-esm-example)
  - [CommonJS Example](#withbackgroundspan-commonjs-example)
- [Custom Database Spans (`withDbSpan`)](#custom-database-spans-withdbspan)
  - [ESM Example](#withdbspan-esm-example)
  - [CommonJS Example](#withdbspan-commonjs-example)
- [Error Tracking & Context Enrichment](#error-tracking--context-enrichment)
  - [Explicit Error Capture (`captureError`)](#explicit-error-capture-captureerror)
  - [Breadcrumbs, User Identity & Tags](#breadcrumbs-user-identity--tags)
- [Custom Metrics Tracking](#custom-metrics-tracking)
- [Lifecycle & Graceful Shutdown](#lifecycle--graceful-shutdown)
- [API Reference](#api-reference)

---

## Features

- **Turnkey Auto-Instrumentation**: Automatically instruments HTTP/HTTPS, Express, Fastify, PostgreSQL (`pg`), Redis (`redis`, `ioredis`), MongoDB, MySQL2, Prisma, BullMQ, Axios, Undici, and `fetch`.
- **Truthful Timing & Exclusive Durations**: Zero synthetic duration clamping. High-resolution monotonic interval calculation separates Node.js CPU execution time from database and network wait time.
- **Detached Background Traces**: First-class support for post-response asynchronous tasks (emails, webhooks, queue publish) via causal `SpanLink` without leaking HTTP trace memory.
- **Native ESM Support**: Synchronous in-thread loader hooks via `import-in-the-middle` (`--import @pulse-apm/node/register`).
- **Distributed W3C Tracing**: Strict compliance with W3C `traceparent` and `baggage` standards across incoming requests and outgoing HTTP calls.
- **Automated PII Sanitization**: Masks credit card numbers (Luhn check), passwords, JWTs, SQL query literals, and sensitive Redis keys out of the box.
- **Memory Bounded & Concurrency Safe**: 1000 concurrent background spans ceiling with deterministic fail-open degradation, circuit-breaker protected transport, and unref'd internal timers.

---

## Installation

```bash
npm install @pulse-apm/node
```

> **Requirements:** Node.js `>= 18.19.0` (or Node.js `>= 20.6.0` for native ESM `--import` support).

---

## SDK Initialization & Startup

Always initialize the SDK **as early as possible** in your application lifecycle, before importing database drivers or starting your HTTP server.

### 1. ECMAScript Modules (ESM) — Recommended

If your project uses `"type": "module"` in `package.json`:

#### Step 1: Preload the ESM Loader Hook (Important for Native ESM Drivers)
To ensure static `import pg from 'pg'` and `import redis from 'redis'` are automatically intercepted before execution, launch Node with the `--import` flag:

```bash
# Development / Production command
node --import @pulse-apm/node/register server.js
```

> **Why?** Node.js evaluates static ESM imports before executing module code. The `--import` flag registers synchronous `import-in-the-middle` hooks into the module loader, guaranteeing database and HTTP drivers are automatically wrapped without code changes.

#### Step 2: Initialize in Code

```typescript
// server.js or app.ts
import { createSDK } from '@pulse-apm/node'

// Initialize the SDK before starting your server
await createSDK({
  apiKey: process.env.PULSE_API_KEY || 'pk_live_your_api_key_here',
  applicationName: 'billing-service',
  environment: process.env.NODE_ENV || 'production',
  release: '1.2.0',
})

// Import frameworks and database drivers AFTER initialization
import express from 'express'
import pg from 'pg'

const app = express()
// ... continue setting up your app
```

---

### 2. CommonJS (CJS)

If your project uses standard CommonJS (`require`):

```javascript
// server.js
const { createSDK } = require('@pulse-apm/node')

async function bootstrap() {
  // 1. Initialize the SDK at the very top of your entrypoint
  await createSDK({
    apiKey: process.env.PULSE_API_KEY || 'pk_live_your_api_key_here',
    applicationName: 'billing-service',
    environment: process.env.NODE_ENV || 'production',
    release: '1.2.0',
  })

  // 2. Require frameworks and database drivers AFTER initialization
  const express = require('express')
  const { Pool } = require('pg')

  const app = express()
  // ... continue setting up your app
}

bootstrap().catch(console.error)
```

Run standard Node:
```bash
node server.js
```

---

## Framework Integration

### Express.js Integration

To capture incoming HTTP requests, route parameters, response status codes, payload sizes, and correlate errors, mount `monitorMiddleware()` early in your middleware chain and `expressErrorHandler()` after all routes.

#### Express ESM Example

```typescript
import { createSDK, monitorMiddleware, expressErrorHandler } from '@pulse-apm/node'
import express from 'express'
import pg from 'pg'

// 1. Initialize SDK
await createSDK({ apiKey: process.env.PULSE_API_KEY! })

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
const { createSDK, monitorMiddleware, expressErrorHandler } = require('@pulse-apm/node')
const express = require('express')
const { Pool } = require('pg')

async function main() {
  await createSDK({ apiKey: process.env.PULSE_API_KEY })

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
import { createSDK, fastifyPulsePlugin } from '@pulse-apm/node'
import Fastify from 'fastify'

await createSDK({ apiKey: process.env.PULSE_API_KEY! })

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
| **MongoDB** | `mongodb` (v4, v5, v6) | Collection, operation (`find`, `update`), latency |
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

#### `withSpan` ESM Example

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

#### `withSpan` CommonJS Example

```javascript
const { withSpan } = require('@pulse-apm/node')

async function calculateRiskScore(userProfile) {
  return await withSpan('fraud.calculate_risk', async (span) => {
    span.setAttribute('user.id', userProfile.id)
    span.setAttribute('user.country', userProfile.country)

    try {
      const score = await runFraudModel(userProfile)
      span.setAttribute('fraud.risk_score', score)
      span.setStatus('ok')
      return score
    } catch (err) {
      // Record error on the span
      span.recordError(err)
      span.setStatus('error', err.message)
      throw err
    }
  })
}

module.exports = { calculateRiskScore }
```

---

### Synchronous Function Tracing (`withSpanSync`)

For synchronous operations (e.g. CPU-intensive JSON parsing, encryption, parsing templates):

```typescript
import { withSpanSync } from '@pulse-apm/node'

const parsedData = withSpanSync('crypto.decrypt_payload', (span) => {
  span.setAttribute('crypto.algorithm', 'aes-256-gcm')
  const decrypted = decrypt(payload, secretKey)
  span.setStatus('ok')
  return decrypted
})
```

---

## Detached Background Work (`withBackgroundSpan`)

In web servers, operations often continue **after** the HTTP response has been sent to the client (e.g. sending welcome emails, dispatching webhooks, publishing events to queues, updating search indices).

### When to Use `withBackgroundSpan` vs `withSpan`

| Feature | `withSpan` | `withBackgroundSpan` |
|---|---|---|
| **Lifecycle** | In-request (<250ms post-response) | Long-running (unlimited / custom timeout) |
| **Trace Relationship** | Child of HTTP request trace | **Independent root trace** with fresh `traceId` |
| **Correlation** | Parent-Child (`parentSpanId`) | OpenTelemetry **`SpanLink`** (`pulse.link.type: 'caused_by'`) |
| **Safety Deadline** | Subject to HTTP 250ms quiescing timeout | Decoupled; unaffected by HTTP response completion |
| **Context Store** | Shared request breadcrumbs | **Forked breadcrumb ring-buffer** (`[requestId]-bg-[id]`) |
| **Concurrency** | Unbounded | Governed by `MAX_CONCURRENT_BACKGROUND_SPANS = 1000` |
| **Use Cases** | Database queries, service calls during request | Fire-and-forget emails, webhooks, queue publish, post-response tasks |

---

### `withBackgroundSpan` ESM Example

```typescript
import { withBackgroundSpan } from '@pulse-apm/node'
import express from 'express'

const app = express()

app.post('/api/register', async (req, res) => {
  // 1. Complete in-request database work
  const user = await db.createUser(req.body)

  // 2. Respond immediately to the client
  res.status(201).json({ success: true, userId: user.id })

  // 3. Detached background task (runs AFTER response without being dropped)
  void withBackgroundSpan('jobs.send_welcome_email', {
    timeoutMs: 10_000, // 10-second fail-open safety timeout
    attributes: {
      'user.id': user.id,
      'email.type': 'welcome_v2',
    }
  }, async (span) => {
    // Automatically linked to the HTTP request trace via causal SpanLink!
    // Database and external HTTP calls inside here are automatically traced
    await emailService.sendTemplate(user.email, 'welcome', { name: user.name })
    await auditLog.record(user.id, 'registration_email_sent')
    
    span.setStatus('ok')
  }).catch(err => {
    console.error('Background email failed:', err)
  })
})
```

---

### `withBackgroundSpan` CommonJS Example

```javascript
const { withBackgroundSpan } = require('@pulse-apm/node')

function dispatchWebhook(eventPayload) {
  // Fire-and-forget background job
  withBackgroundSpan('webhooks.dispatch', {
    timeoutMs: 15_000,
    attributes: {
      'webhook.event': eventPayload.type,
      'webhook.target_url': eventPayload.url,
    }
  }, async (span) => {
    const response = await axios.post(eventPayload.url, eventPayload.data, { timeout: 10000 })
    span.setAttribute('http.status_code', response.status)
    span.setStatus('ok')
  }).catch(err => {
    // Application errors are safely handled
    console.error('Webhook delivery failed:', err.message)
  })
}

module.exports = { dispatchWebhook }
```

---

## Custom Database Spans (`withDbSpan`)

If you use a custom internal database wrapper, a NoSQL store, or a driver not natively auto-instrumented (e.g. Cassandra, ClickHouse, SQLite):

### `withDbSpan` ESM Example

```typescript
import { withDbSpan } from '@pulse-apm/node'

export async function queryClickhouse(sql: string) {
  return await withDbSpan('other', 'SELECT', async (span) => {
    span.setAttribute('db.name', 'analytics')
    span.setAttribute('db.sql.table', 'page_views')
    
    const data = await rawClickhouseClient.query(sql)
    return data
  }, {
    statement: sql, // SQL query is automatically sanitized/redacted
    captureStatement: true,
  })
}
```

### `withDbSpan` CommonJS Example

```javascript
const { withDbSpan } = require('@pulse-apm/node')

async function executeCassandraQuery(queryStr, params) {
  return await withDbSpan('cassandra', 'SELECT', async (span) => {
    span.setAttribute('db.name', 'keyspace_orders')
    span.setAttribute('db.cassandra.consistency_level', 'LOCAL_QUORUM')

    const result = await cassandraClient.execute(queryStr, params)
    return result
  }, {
    statement: queryStr,
  })
}

module.exports = { executeCassandraQuery }
```

---

## Error Tracking & Context Enrichment

### Explicit Error Capture (`captureError`)

The SDK automatically captures unhandled exceptions and route errors via `expressErrorHandler()`. To manually record caught exceptions with active context:

```typescript
import { captureError } from '@pulse-apm/node'

try {
  await riskyExternalCall()
} catch (error) {
  // Captures the error, attaches active traceId, spanId, breadcrumbs, and request details
  captureError(error, {
    extra: {
      retryCount: 3,
      customerId: 'cust_98231',
    },
    tags: {
      subsystem: 'external_gateway',
    },
    fingerprint: ['external_gateway', 'timeout'],
  })
}
```

---

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

## Lifecycle & Graceful Shutdown

In containerized environments (Kubernetes, Docker, AWS ECS), ensure pending spans, traces, and metrics are flushed before the process terminates:

```typescript
import { flush, shutdown } from '@pulse-apm/node'

async function onSignal() {
  console.log('Received termination signal. Shutting down gracefully...')
  
  // Flushes all pending trace debounces, metrics, and network transport queues
  await shutdown(2000) // 2000ms maximum wait deadline
  
  process.exit(0)
}

process.on('SIGTERM', onSignal)
process.on('SIGINT', onSignal)
```

---

## API Reference

| Function / Export | Purpose | Common Usage |
|---|---|---|
| `createSDK(options)` | Recommended SDK initialization function. | `await createSDK({ apiKey: '...' })` |
| `init(options)` | Canonical initialization function (alias to `createSDK`). | `await init({ apiKey: '...' })` |
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
| `shutdown(timeoutMs)` | Flushes telemetry and cleanly releases resources. | `await shutdown(2000)` |

---

## License

ISC © Pulse APM

