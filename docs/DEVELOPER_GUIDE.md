# Pulse APM Node.js SDK — Complete Developer Guide

> **Package**: `@pulse-apm/node`  
> **Version**: 8.3.12  
> **Target Runtime**: Node.js `>= 18.19.0` (Native ESM & CommonJS)  

This developer guide provides complete, production-ready code examples and architectural patterns for every feature of the `@pulse-apm/node` observability SDK.

---

## Table of Contents

1. [Quick Start & Module Systems](#1-quick-start--module-systems)
   - [ECMAScript Modules (ESM) — Recommended](#ecmascript-modules-esm--recommended)
   - [CommonJS (CJS)](#commonjs-cjs)
2. [Configuration & Environment Discovery (.env)](#2-configuration--environment-discovery-env)
   - [Zero-Dependency .env Loading](#zero-dependency-env-loading)
   - [Endpoint Precedence Order](#endpoint-precedence-order)
   - [3-Tier Init Options Reference](#3-tier-init-options-reference)
3. [Web Framework Monitoring](#3-web-framework-monitoring)
   - [Express.js](#expressjs)
   - [Fastify](#fastify)
   - [NestJS](#nestjs)
4. [Automatic Database & Cache Auto-Instrumentation](#4-automatic-database--cache-auto-instrumentation)
   - [PostgreSQL (`pg`, `pg-pool`)](#postgresql-pg-pg-pool)
   - [MongoDB & Mongoose](#mongodb--mongoose)
   - [Prisma Client](#prisma-client)
   - [Redis (`redis`, `ioredis`)](#redis-redis-ioredis)
5. [Custom Business Spans (`withSpan`, `withSpanSync`)](#5-custom-business-spans-withspan-withspansync)
   - [Asynchronous Functions (`withSpan`)](#asynchronous-functions-withspan)
   - [Synchronous Functions (`withSpanSync`)](#synchronous-functions-withspansync)
6. [Detached Post-Response Background Tasks (`withBackgroundSpan`)](#6-detached-post-response-background-tasks-withbackgroundspan)
7. [Custom Database Spans (`withDbSpan`)](#7-custom-database-spans-withdbspan)
8. [Error Tracking & User Diagnostics](#8-error-tracking--user-diagnostics)
   - [Explicit Error Capture (`captureError`)](#explicit-error-capture-captureerror)
   - [User Identity (`setUser`)](#user-identity-setuser)
   - [Diagnostic Breadcrumbs (`addBreadcrumb`)](#diagnostic-breadcrumbs-addbreadcrumb)
9. [Custom Application Metrics Tracking](#9-custom-application-metrics-tracking)
10. [High-Throughput Services & Adaptive Sampling (>10k RPS)](#10-high-throughput-services--adaptive-sampling-10k-rps)
11. [Container Lifecycle & Graceful Shutdown](#11-container-lifecycle--graceful-shutdown)
    - [Automatic Signal Handling (Default)](#automatic-signal-handling-default)
    - [Manual Shutdown Orchestration](#manual-shutdown-orchestration)
12. [Advanced Data Privacy & Pipeline Hooks](#12-advanced-data-privacy--pipeline-hooks)
    - [Custom Payload Redaction (`beforeSend`)](#custom-payload-redaction-beforesend)
    - [Breadcrumb Filtering (`beforeBreadcrumb`)](#breadcrumb-filtering-beforebreadcrumb)
13. [Diagnostics & Troubleshooting](#13-diagnostics--troubleshooting)
    - [TypeScript Source Maps](#typescript-source-maps)
    - [Debug Logging](#debug-logging)

---

## 1. Quick Start & Module Systems

Always initialize the SDK **before** importing database drivers, HTTP clients, or web frameworks.

### ECMAScript Modules (ESM) — Recommended

In native ESM (`"type": "module"` in `package.json`), static `import` declarations evaluate before the main script executes. To ensure drivers (like `pg` or `redis`) are intercepted at import time, launch Node with the `--import` preload flag:

```bash
# Production launch command
node --import @pulse-apm/node/register dist/server.js
```

Initialize in your application entrypoint:

```typescript
// server.ts
import { init } from '@pulse-apm/node'

// 1. Initialize the SDK first with your apiKey
await init({
  apiKey: process.env.PULSE_API_KEY!,
})

// 2. Import frameworks and drivers AFTER initialization
import express from 'express'
import pg from 'pg'

const app = express()
```

### CommonJS (CJS)

If your project uses CommonJS (`require`):

```javascript
// server.js
const { init } = require('@pulse-apm/node')

async function bootstrap() {
  // 1. Initialize with apiKey
  await init({
    apiKey: process.env.PULSE_API_KEY || 'pls_live_your_api_key_here',
  })

  // 2. Require frameworks and drivers AFTER initialization
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

## 2. Configuration & Environment Discovery (.env)

### Zero-Dependency .env Loading

The SDK automatically detects and loads the `.env` file from the root directory of your host application (`process.cwd()`) without requiring the `dotenv` package:

```env
# .env in host project root
PULSE_API_KEY=pls_live_abcdef1234567890
PULSE_ENDPOINT=http://127.0.0.1:3000
```

### Endpoint Precedence Order

When resolving your backend ingestion endpoint, the SDK applies the following priority order:

1. `endpoint` in `init({ apiKey, endpoint: '...' })`
2. `PULSE_ENDPOINT` from `.env` or system environment
3. `PULSE_API_URL`
4. `PULSE_BASE_URL`
5. `BACKEND_URL`
6. `SDK_BASE_URL`
7. Default production origin (`http://127.0.0.1:5000`)

### 3-Tier Init Options Reference

Options passed to `init()` strictly control local process-level integration:

```typescript
import { init } from '@pulse-apm/node'

await init({
  // ─── TIER 1: Core Configuration (Required) ────────────────────────────────
  apiKey: 'pls_live_abcdef1234567890',

  // ─── TIER 2: Infrastructure & DevOps (Optional) ───────────────────────────
  endpoint: 'http://internal-proxy:3000', // Custom collector or proxy
  adaptiveSampling: true,                 // Dynamic rate scaling under load (>10k RPS)
  handleSignals: true,                    // Intercept SIGTERM/SIGINT for container drain (default: true)
  initTimeoutMs: 1500,                    // Fail-open startup deadline (default: 1500ms)
  shutdownTimeoutMs: 5000,                // Drain deadline on shutdown (default: 5000ms)

  // ─── TIER 3: Pipeline & Compliance Hooks (Optional) ───────────────────────
  beforeSend: (event) => event,           // Custom event transformer/redactor
  beforeBreadcrumb: (crumb) => crumb,     // Custom breadcrumb filter
  sourceMaps: { paths: ['./dist'] },      // Path to compiled .map files
  maxBreadcrumbs: 100,                    // Memory buffer limit (default: 100)
  debug: false,                           // Diagnostic logging to stdout
  logLevel: 'info',                       // 'debug' | 'info' | 'warning' | 'error'
})
```

---

## 3. Web Framework Monitoring

### Express.js

Mount `monitorMiddleware()` early in your middleware chain (after body parsing) and `expressErrorHandler()` after all routes:

```typescript
import { init, monitorMiddleware, expressErrorHandler } from '@pulse-apm/node'
import express from 'express'
import pg from 'pg'

await init({ apiKey: process.env.PULSE_API_KEY! })

const app = express()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

// 1. Body parser
app.use(express.json())

// 2. Pulse monitoring middleware
app.use(monitorMiddleware())

// 3. Application routes
app.get('/api/users/:id', async (req, res) => {
  // DB query is automatically intercepted as a child span:
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id])
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json({ user: result.rows[0] })
})

// 4. Pulse error handling middleware (must be registered last)
app.use(expressErrorHandler())

app.listen(3000, () => console.log('Server running on port 3000'))
```

### Fastify

Register `fastifyPulsePlugin` with your Fastify instance:

```typescript
import { init, fastifyPulsePlugin } from '@pulse-apm/node'
import Fastify from 'fastify'

await init({ apiKey: process.env.PULSE_API_KEY! })

const fastify = Fastify({ logger: true })

// Register Pulse plugin
await fastify.register(fastifyPulsePlugin)

fastify.get('/api/orders/:id', async (request, reply) => {
  return { orderId: request.params.id, status: 'shipped' }
})

await fastify.listen({ port: 3000 })
```

### NestJS

In NestJS applications, initialize the SDK before calling `NestFactory.create()`:

```typescript
// main.ts
import { init, monitorMiddleware, expressErrorHandler } from '@pulse-apm/node'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  await init({ apiKey: process.env.PULSE_API_KEY! })

  const app = await NestFactory.create(AppModule)
  app.use(monitorMiddleware())
  app.use(expressErrorHandler())

  await app.listen(3000)
}
bootstrap()
```

---

## 4. Automatic Database & Cache Auto-Instrumentation

Database and cache operations are automatically intercepted without writing manual spans.

### PostgreSQL (`pg`, `pg-pool`)

```typescript
import pg from 'pg'

const pool = new pg.Pool()

// Automatically captured as a child span under the active HTTP request:
// - db.system: 'postgresql'
// - db.statement: 'SELECT id, email FROM users WHERE id = $1' (sanitized)
// - db.duration: accurate high-resolution latency
const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId])
```

### MongoDB & Mongoose

The SDK automatically intercepts native MongoDB driver queries and Mongoose models while avoiding duplicate driver spans:

```typescript
import mongoose from 'mongoose'

const User = mongoose.model('User', new mongoose.Schema({ email: String, name: String }))

// Automatically intercepted:
// - Exactly ONE canonical span created per logical query
// - Startup index creation commands (createIndexes, buildInfo) are filtered to save quotas
const user = await User.findOne({ email: 'user@example.com' }).exec()
```

### Prisma Client

Interception works with root clients and interactive transaction clients:

```typescript
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Standard query:
const user = await prisma.user.findUnique({ where: { id: 1 } })

// Interactive transaction (all sub-operations are traced):
await prisma.$transaction(async (tx) => {
  await tx.account.update({ where: { id: 1 }, data: { balance: { decrement: 50 } } })
  await tx.account.update({ where: { id: 2 }, data: { balance: { increment: 50 } } })
})
```

### Redis (`redis`, `ioredis`)

```typescript
import Redis from 'ioredis'

const redis = new Redis()

// Captured with sanitized command and key:
await redis.set('session:123', 'active', 'EX', 3600)
const session = await redis.get('session:123')
```

---

## 5. Custom Business Spans (`withSpan`, `withSpanSync`)

### Asynchronous Functions (`withSpan`)

Use `withSpan` to track custom business logic or external API calls:

```typescript
import { withSpan } from '@pulse-apm/node'

export async function processPayment(orderId: string, amount: number) {
  return await withSpan('payments.process', async (span) => {
    // 1. Add searchable attributes
    span.setAttribute('payment.order_id', orderId)
    span.setAttribute('payment.amount', amount)
    span.setAttribute('payment.currency', 'USD')

    // 2. Perform business logic
    const gatewayResult = await callPaymentGateway(orderId, amount)

    // 3. Set span status
    if (gatewayResult.success) {
      span.setStatus('ok')
      span.setAttribute('payment.transaction_id', gatewayResult.txnId)
      return gatewayResult
    } else {
      span.setStatus('error', gatewayResult.error)
      throw new Error(`Payment failed: ${gatewayResult.error}`)
    }
  })
}
```

### Synchronous Functions (`withSpanSync`)

```typescript
import { withSpanSync } from '@pulse-apm/node'

const signature = withSpanSync('crypto.signToken', (span) => {
  span.setAttribute('crypto.algorithm', 'sha256')
  return signData(payload, secretKey)
})
```

---

## 6. Detached Post-Response Background Tasks (`withBackgroundSpan`)

When tasks execute *after* an HTTP response has completed (e.g. sending receipt emails, updating analytics, publishing to Kafka), standard spans risk memory leaks.

`withBackgroundSpan` creates an independent, detached trace linked back to the original request via a W3C `SpanLink`:

```typescript
import { withBackgroundSpan } from '@pulse-apm/node'

app.post('/api/checkout', async (req, res) => {
  const order = await createOrder(req.body)

  // 1. Respond to the customer immediately:
  res.status(201).json({ orderId: order.id })

  // 2. Execute detached task asynchronously:
  withBackgroundSpan('checkout.send_receipt_email', { timeoutMs: 10000 }, async (span) => {
    span.setAttribute('order.id', order.id)
    await emailClient.sendReceipt(order.email, order)
  })
})
```

---

## 7. Custom Database Spans (`withDbSpan`)

If using raw database connections or proprietary drivers, wrap queries with `withDbSpan`:

```typescript
import { withDbSpan } from '@pulse-apm/node'

const users = await withDbSpan('postgresql', 'SELECT', async (span) => {
  span.setAttribute('db.sql.table', 'users')
  return await rawConnection.execute('SELECT * FROM users')
})
```

---

## 8. Error Tracking & User Diagnostics

### Explicit Error Capture (`captureError`)

```typescript
import { captureError } from '@pulse-apm/node'

try {
  await syncThirdPartyData()
} catch (error) {
  captureError(error, {
    tags: { integration: 'salesforce' },
    extra: { attemptNumber: 3, lastSync: Date.now() },
    mechanism: 'sync_job',
  })
  throw error
}
```

### User Identity (`setUser`)

Attach user and tenant identity to all subsequent traces and error reports:

```typescript
import { setUser } from '@pulse-apm/node'

// In auth middleware:
setUser({
  id: 'usr_98124',
  email: 'alex@company.com',
  tenantId: 'org_enterprise_acme',
})
```

### Diagnostic Breadcrumbs (`addBreadcrumb`)

```typescript
import { addBreadcrumb } from '@pulse-apm/node'

addBreadcrumb({
  category: 'checkout',
  message: 'User entered coupon code',
  level: 'info',
  data: { code: 'SUMMER2026', discount: '20%' },
})
```

---

## 9. Custom Application Metrics Tracking

The SDK includes a high-performance OpenTelemetry metrics client:

```typescript
import { incrementCounter, recordHistogram, setGauge } from '@pulse-apm/node'

// 1. Counters (e.g. business events, order volume)
incrementCounter('orders.completed', 1, {
  paymentMethod: 'stripe',
  tier: 'enterprise',
})

// 2. Histograms (e.g. latency distributions, payload sizes)
recordHistogram('api.external_call.latency_ms', 124.8, {
  targetService: 'billing_service',
})

// 3. Gauges (e.g. instantaneous resource levels)
setGauge('worker.active_queue_jobs', 18)
```

---

## 10. High-Throughput Services & Adaptive Sampling (>10k RPS)

In high-throughput services (>10,000 RPS), static trace sampling can result in high telemetry ingestion costs.

Enable **Adaptive Sampling** to throttle non-error trace volume dynamically under system pressure while **guaranteeing 100% error event capture**:

```typescript
import { init } from '@pulse-apm/node'

await init({
  apiKey: process.env.PULSE_API_KEY!,
  adaptiveSampling: true, // Enables dynamic system pressure scaling
})
```

### Pressure Scaling Behavior:
* **`HEALTHY`**: 100% of configured sample rate.
* **`ELEVATED`**: Throttles non-error telemetry to at most **80%**.
* **`PRESSURED`**: Throttles non-error telemetry to at most **50%**.
* **`CRITICAL`**: Throttles non-error telemetry to at most **10%**.
* **Errors**: **100% exempt**. Every single error event is captured and dispatched even under critical system pressure.

---

## 11. Container Lifecycle & Graceful Shutdown

### Automatic Signal Handling (Default)

By default (`handleSignals: true`), `init()` automatically hooks `SIGTERM` and `SIGINT`:
* Rejects incoming non-critical events to freeze buffer sizes.
* Flushes trace trees, orphan recovery spans, and active span buffers.
* Concurrently drains all transport routes (`traces`, `spans`, `requests`, `metrics`, `errors`).
* Unreferences background timers so the Node process terminates immediately without hanging.

### Manual Shutdown Orchestration

If you use a custom container shutdown orchestrator (such as `@godaddy/terminus` or NestJS shutdown hooks), set `handleSignals: false` and call `shutdown()` manually:

```typescript
import { init, shutdown } from '@pulse-apm/node'

await init({
  apiKey: process.env.PULSE_API_KEY!,
  handleSignals: false, // Manage termination signals manually
})

async function onTermination() {
  console.log('Container stopping. Flushing telemetry batches...')
  await shutdown(3000) // 3000ms deadline
  process.exit(0)
}

process.on('SIGTERM', onTermination)
process.on('SIGINT', onTermination)
```

---

## 12. Advanced Data Privacy & Pipeline Hooks

### Custom Payload Redaction (`beforeSend`)

Transform or redact telemetry payloads before they leave the host process:

```typescript
import { init } from '@pulse-apm/node'

await init({
  apiKey: process.env.PULSE_API_KEY!,
  beforeSend: (event) => {
    // Strip proprietary internal attributes
    if (event['internalAuthToken']) {
      delete event['internalAuthToken']
    }
    // Return null to drop the event completely
    if (event['ignoreMe'] === true) return null
    return event
  },
})
```

### Breadcrumb Filtering (`beforeBreadcrumb`)

```typescript
await init({
  apiKey: process.env.PULSE_API_KEY!,
  beforeBreadcrumb: (crumb) => {
    // Drop high-frequency diagnostic noise
    if (crumb.category === 'redis.ping') return null
    return crumb
  },
})
```

---

## 13. Diagnostics & Troubleshooting

### TypeScript Source Maps

For symbolicated stack traces pointing to original `.ts` source files rather than compiled `.js` files:

```typescript
await init({
  apiKey: process.env.PULSE_API_KEY!,
  sourceMaps: {
    paths: ['./dist'], // Local container path where .js.map files reside
    allowRemote: false,
  },
})
```

### Debug Logging

To troubleshoot SDK connectivity or configuration resolution in development or staging:

```typescript
await init({
  apiKey: process.env.PULSE_API_KEY!,
  debug: true,       // Emits structured [Pulse] diagnostic logs to stdout
  logLevel: 'debug', // 'debug' | 'info' | 'warning' | 'error'
})
```
