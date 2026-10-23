# @lynktrace/node

> Enterprise-grade observability and distributed tracing SDK for Node.js applications, built natively on OpenTelemetry with automated framework and database interception, truthful timing attribution, adaptive load shedding, resilient offline disk spooling, continuous CPU profiling with duty-cycle cooling, system hardware metrics (CPU, GPU, Disk, GC, Event Loop), and isolated multi-route event transport.

[![Version](https://img.shields.io/badge/version-3.1.1-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)]()
[![Module System](https://img.shields.io/badge/module-ESM%20%7C%20CommonJS-orange.svg)]()
[![Runtimes](https://img.shields.io/badge/runtimes-Node.js%20%7C%20Bun-purple.svg)]()
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](package.json)

---

## Table of Contents

- [1. Overview & Architecture](#1-overview--architecture)
- [2. System Requirements & Runtime Compatibility](#2-system-requirements--runtime-compatibility)
- [3. Installation Across Package Managers (npm, pnpm, yarn, bun)](#3-installation-across-package-managers-npm-pnpm-yarn-bun)
- [4. Integration Strategy: Full Auto-Instrumentation vs. Middleware-Only](#4-integration-strategy-full-auto-instrumentation-vs-middleware-only)
- [5. Recommended Setup by Module System & Runtime](#5-recommended-setup-by-module-system--runtime)
  - [5.1 Modular JavaScript (ESM — `import`)](#51-modular-javascript-esm--import)
  - [5.2 CommonJS (CJS — `require`)](#52-commonjs-cjs--require)
  - [5.3 Bun Runtime](#53-bun-runtime)
  - [5.4 TypeScript Development Tooling (`tsx` & `ts-node`)](#54-typescript-development-tooling-tsx--ts-node)
  - [5.5 Docker & Container Environments](#55-docker--container-environments)
  - [5.6 Kubernetes Deployments](#56-kubernetes-deployments)
- [6. Complete Framework Integration Guides & Route Snippets](#6-complete-framework-integration-guides--route-snippets)
  - [6.1 Express.js Application (ESM & CJS)](#61-expressjs-application-esm--cjs)
  - [6.2 Fastify Application](#62-fastify-application)
  - [6.3 NestJS Application](#63-nestjs-application)
  - [6.4 Serverless & AWS Lambda (`wrapHandler`)](#64-serverless--aws-lambda-wraphandler)
  - [6.5 Background Workers & Job Queues (BullMQ / CLI)](#65-background-workers--job-queues-bullmq--cli)
- [7. Zero-Code Preload & Process Bootstrap (`register.ts`)](#7-zero-code-preload--process-bootstrap-registerts)
- [8. SDK Initialization (`init`) & Complete Options Reference](#8-sdk-initialization-init--complete-options-reference)
  - [Complete `init()` Options Reference](#complete-init-options-reference)
  - [Fail-Open Initialization & Recovery Invariants](#fail-open-initialization--recovery-invariants)
- [9. Feature Guides & Workload Profiles](#9-feature-guides--workload-profiles)
  - [Recommended Profile by Workload](#recommended-profile-by-workload)
  - [Disabling Subsystems Locally and Remotely](#disabling-subsystems-locally-and-remotely)
  - [Disabling Disk Storage for Serverless & Read-Only Disks](#disabling-disk-storage-for-serverless--read-only-disks)
  - [Emergency Operational Killswitches](#emergency-operational-killswitches)
- [10. Core Features & Capabilities](#10-core-features--capabilities)
  - [A. Error Tracking & Exception Capture](#a-error-tracking--exception-capture)
  - [B. Distributed Tracing & W3C Context Propagation](#b-distributed-tracing--w3c-context-propagation)
  - [C. Custom Spans & Database Query Attribution](#c-custom-spans--database-query-attribution)
  - [D. Detached Background Task Tracing (`withBackgroundSpan`)](#d-detached-background-task-tracing-withbackgroundspan)
  - [E. OpenTelemetry Metrics & Exponential Histograms](#e-opentelemetry-metrics--exponential-histograms)
  - [F. V8 CPU & Heap Profiling with Duty-Cycle Cooling](#f-v8-cpu--heap-profiling-with-duty-cycle-cooling)
  - [G. Hardware & Runtime Resource Monitors](#g-hardware--runtime-resource-monitors)
    - [1. CPU Load & Throttling Monitor](#1-cpu-load--throttling-monitor)
    - [2. GPU Detector (NVIDIA & Apple Silicon)](#2-gpu-detector-nvidia--apple-silicon)
    - [3. Storage & Disk Capacity Detector](#3-storage--disk-capacity-detector)
    - [4. V8 Garbage Collection (GC) Monitor](#4-v8-garbage-collection-gc-monitor)
    - [5. Event Loop Delay & Lag Monitor](#5-event-loop-delay--lag-monitor)
    - [6. Container Memory Pressure & Hysteresis State Machine](#6-container-memory-pressure--hysteresis-state-machine)
  - [H. Structured Logging & Breadcrumbs](#h-structured-logging--breadcrumbs)
  - [I. Cron & Scheduled Job Heartbeats (`captureCronCheckIn`)](#i-cron--scheduled-job-heartbeats-capturecroncheckin)
  - [J. Custom Business Event Ingestion](#j-custom-business-event-ingestion)
- [11. Transport Pipeline & Resilience Guarantees](#11-transport-pipeline--resilience-guarantees)
  - [Per-Route Queue Isolation](#per-route-queue-isolation)
  - [Worker Thread Serialization & Event Loop Protection](#worker-thread-serialization--event-loop-protection)
  - [Strict LRU Retry Bookkeeping](#strict-lru-retry-bookkeeping)
  - [Circuit Breakers & Exponential Backoff](#circuit-breakers--exponential-backoff)
  - [Offline Disk Spooling & Deduplication](#offline-disk-spooling--deduplication)
- [12. Privacy, PII Scrubbing & Security](#12-privacy-pii-scrubbing--security)
- [13. Complete API Reference](#13-complete-api-reference)
- [14. Graceful Shutdown & Kubernetes Lifecycle](#14-graceful-shutdown--kubernetes-lifecycle)
- [15. Troubleshooting & Production Best Practices](#15-troubleshooting--production-best-practices)

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
        │  (Luhn PAN credit cards, SSNs, JWTs, Auth headers, JSON body scrubbing)
        │
        ▼
[ Deterministic Sampling Engine ]
        │  (Head-based FNV-1a trace sampling + route-specific overrides)
        │
        ▼
[ Transport Priority Event Queue ]
        │  ├── Critical Ring (capacity: criticalReserve for fatal crashes, errors, crons)
        │  └── Normal Ring (capacity: maxSize - criticalReserve for spans, logs, metrics)
        │
        ▼
[ Adaptive Load Shedder & Circuit Breakers ]
        │  (Drops normal ring events based on Event-Loop Lag & Heap limits)
        │
        ▼
[ Worker Thread Serialization Pool (Batches > 50KB & All Profiles) & Gzip ]
        │
        ├── Network Route Senders (10 Dedicated Transport Routes)
        │       ├── /v1/errors
        │       ├── /v1/traces
        │       ├── /v1/spans
        │       ├── /v1/requests
        │       ├── /v1/metrics
        │       ├── /v1/logs
        │       ├── /v1/profiles
        │       ├── /v1/crons
        │       └── /v1/events (Messages & Custom Business Events)
        │
        └── Offline Disk Spooling Fallback (Persistent NDJSON Queue on Outage)
```

---

## 2. System Requirements & Runtime Compatibility

- **Node.js**: `>= 18.0.0` (Fully verified and tested on Node.js 18 LTS, 20 LTS, 22 LTS, and 26+)
- **Bun**: `>= 1.0.0` (Native execution supported)
- **Operating Systems**: Linux (Ubuntu, Debian, Alpine, RHEL, CentOS), macOS (Intel & Apple Silicon ARM64), Windows (x64, ARM64)
- **Container Runtimes**: Docker, Kubernetes, AWS ECS, Google Cloud Run, Azure Container Apps
- **Serverless Environments**: AWS Lambda, Vercel Functions, Google Cloud Functions, Netlify Functions
- **Module Systems**: ECMAScript Modules (`import` / ESM) and CommonJS (`require` / CJS)
- **TypeScript**: `>= 5.0.0` (Complete declarations bundled in `dist/index.d.ts` and `dist/internals.d.ts`)

---

## 3. Installation Across Package Managers (npm, pnpm, yarn, bun)

Install the SDK using your package manager of choice:

```bash
# npm
npm install @lynktrace/node

# pnpm
pnpm add @lynktrace/node

# yarn
yarn add @lynktrace/node

# bun
bun add @lynktrace/node
```

### Optional Peer Dependencies
The SDK includes built-in auto-instrumentation hooks for popular databases and job queues that activate automatically when present:
- `@prisma/client`: `^5.0.0 || ^6.0.0 || ^7.0.0`
- `bullmq`: `^2.0.0 || ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0`
- `pg`, `mysql2`, `mongodb`, `ioredis`, `redis`, `kafkajs`, `amqplib`

---

## 4. Integration Strategy: Full Auto-Instrumentation vs. Middleware-Only

The SDK provides two distinct integration approaches depending on your architectural requirements:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               WHICH METHOD SHOULD YOU USE?                             │
├───────────────────────────────┬───────────────────────────────┬────────────────────────┤
│ Feature Requirement           │ Approach A: Full Auto-Trace   │ Approach B: Middleware │
├───────────────────────────────┼───────────────────────────────┼────────────────────────┤
│ Incoming HTTP Request Tracing │ ✅ Yes (Node http core level) │ ✅ Yes (Express/Fastify)│
│ Express Route Parameters      │ ✅ Yes                        │ ✅ Yes                 │
│ Express Error Capture         │ ✅ Yes                        │ ✅ Yes                 │
│ Database Queries (PG, Redis)  │ ✅ Yes (Auto child spans)     │ ❌ Manual spans needed │
│ Outbound HTTP (Fetch, Axios)  │ ✅ Yes (Auto child spans)     │ ❌ Manual spans needed │
│ CLI Preload Flag Required?    │ ✅ Yes (`--import` or `-r`)   │ ❌ No (Pure in-code)   │
│ Should you import register.ts?│ ✅ Yes (via `--import`)       │ ❌ No (Not required)   │
└───────────────────────────────┴───────────────────────────────┴────────────────────────┘
```

### Approach A: Full Auto-Instrumentation (Recommended for Production APIs)
- **How to run**: `node --import @lynktrace/node/register dist/index.js`
- **Why**: Intercepts Node's module loader before your application loads `express`, `pg`, `mysql2`, `redis`, or `fetch`.
- **Result**: Every inbound HTTP request creates a trace, and every subsequent database query or outbound HTTP call automatically appears as a nested child span with zero manual code.

### Approach B: Trace Middleware & Error Handling Only (Lightweight)
- **How to run**: `node dist/index.js` (No CLI flags needed)
- **Why**: If you only care about monitoring Express request durations, status codes, and capturing errors thrown in route handlers.
- **Do you need `register.ts`?**: **NO.** The `lynktraceMiddleware()` automatically detects that core HTTP instrumentation was not preloaded and autonomously creates the root server span and context store directly from incoming headers!

---

## 5. Recommended Setup by Module System & Runtime

### 5.1 Modular JavaScript (ESM — `import`)

In modern Node.js using ECMAScript Modules (`"type": "module"` in `package.json` or `.mjs` files), static `import` statements are hoisted by the JavaScript engine before top-level code executes.

#### Recommended Execution:
Use the `--import` preload flag to ensure auto-instrumentation hooks run before any application dependency is imported:

```bash
node --import @lynktrace/node/register dist/server.js
```

#### In `package.json`:
```json
{
  "type": "module",
  "scripts": {
    "start": "node --import @lynktrace/node/register dist/server.js",
    "dev": "tsx --import @lynktrace/node/register src/server.ts"
  }
}
```

#### Application Code (`src/server.ts` or `src/server.js`):
```typescript
import express from 'express'
import { init, lynktraceMiddleware, expressErrorHandler, captureException } from '@lynktrace/node'

// Initialize SDK with credentials
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'ecommerce-api',
  environment: process.env.NODE_ENV ?? 'production',
})

const app = express()

// 1. MUST be the very first middleware
app.use(lynktraceMiddleware())
app.use(express.json())

// Routes
app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

app.get('/api/users/:id', async (req, res) => {
  res.json({ userId: req.params.id })
})

// 2. MUST be the very last middleware
app.use(expressErrorHandler())

app.listen(3000, () => console.log('ESM Server listening on 3000'))
```

---

### 5.2 CommonJS (CJS — `require`)

In CommonJS environments (`.js` or `.cjs`), modules load synchronously via `require()`.

#### Recommended Execution:
Use the `-r` (require) preload flag:

```bash
node -r @lynktrace/node/register dist/server.js
```

#### In `package.json`:
```json
{
  "scripts": {
    "start": "node -r @lynktrace/node/register dist/server.js",
    "dev": "nodemon -r @lynktrace/node/register src/server.js"
  }
}
```

#### Application Code (`src/server.js`):
```javascript
const express = require('express')
const { init, lynktraceMiddleware, expressErrorHandler, captureException } = require('@lynktrace/node')

async function start() {
  await init({
    apiKey: process.env.LYNKTRACE_API_KEY,
    applicationName: 'legacy-billing-service',
    environment: 'production',
  })

  const app = express()

  // 1. First middleware
  app.use(lynktraceMiddleware())
  app.use(express.json())

  app.get('/api/invoices', async (req, res) => {
    res.json({ invoices: [] })
  })

  // 2. Last middleware
  app.use(expressErrorHandler())

  app.listen(8080, () => console.log('CommonJS Server listening on 8080'))
}

start()
```

---

### 5.3 Bun Runtime

Bun has native support for both CommonJS and ESM, along with built-in TypeScript execution.

#### Installation:
```bash
bun add @lynktrace/node
```

#### Running with Bun:
```bash
# Option 1: With preload for full auto-instrumentation
bun run --preload @lynktrace/node/register server.ts

# Option 2: Direct execution (Middleware & Error Tracking mode)
bun server.ts
```

#### In `package.json`:
```json
{
  "scripts": {
    "start": "bun run --preload @lynktrace/node/register server.ts"
  }
}
```

#### Application Code (`server.ts`):
```typescript
import express from 'express'
import { init, lynktraceMiddleware, expressErrorHandler } from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'bun-microservice',
})

const app = express()
app.use(lynktraceMiddleware())
app.use(express.json())

app.get('/ping', (req, res) => res.send('pong'))

app.use(expressErrorHandler())

app.listen(4000, () => console.log('Bun server running on http://localhost:4000'))
```

---

### 5.4 TypeScript Development Tooling (`tsx` & `ts-node`)

When running TypeScript files directly during local development:

#### Using `tsx` (Modern, Fast):
```bash
npx tsx --import @lynktrace/node/register src/server.ts
```

#### Using `ts-node` (ESM):
```bash
node --loader ts-node/esm --import @lynktrace/node/register src/server.ts
```

#### Using `ts-node` (CommonJS):
```bash
npx ts-node -r @lynktrace/node/register src/server.ts
```

---

### 5.5 Docker & Container Environments

In containerized deployments, configuring `NODE_OPTIONS` ensures that auto-instrumentation runs reliably regardless of how the container entrypoint is started:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

# Preload LynkTrace register hook across all node processes in the container:
ENV NODE_OPTIONS="--import @lynktrace/node/register"

# Recommended: pass credentials securely via runtime environment
EXPOSE 3000

CMD ["node", "dist/server.js"]
```

---

### 5.6 Kubernetes Deployments

In Kubernetes manifests, supply `NODE_OPTIONS` and API keys via Pod specifications:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-api
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: order-api
          image: myregistry.azurecr.io/order-api:v3.1.1
          env:
            - name: NODE_OPTIONS
              value: "--import @lynktrace/node/register"
            - name: LYNKTRACE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: lynktrace-secrets
                  key: api-key
            - name: LYNKTRACE_ENVIRONMENT
              value: "production"
          ports:
            - containerPort: 3000
```

---

## 6. Complete Framework Integration Guides & Route Snippets

### 6.1 Express.js Application (ESM & CJS)

Express integration requires mounting two middlewares in exact order:
1. `lynktraceMiddleware()` as the **very first middleware**.
2. `expressErrorHandler()` as the **very last middleware**.

```typescript
import express from 'express'
import {
  init,
  lynktraceMiddleware,
  expressErrorHandler,
  captureException,
  setUser,
  setTag,
  addBreadcrumb,
} from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'express-sample',
})

const app = express()

// 1. MUST BE REGISTERED BEFORE ALL OTHER MIDDLEWARES & ROUTES
app.use(lynktraceMiddleware({
  ignorePaths: ['/health', '/metrics'], // Skips noise from probes
  instrumentMiddleware: true,          // Profiles middleware execution times
  minMiddlewareDurationMs: 2.0,        // Only records middleware spans if >= 2ms
}))

// Standard body parser middlewares
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Route 1: Standard GET route with route parameter
app.get('/api/users/:userId', async (req, res) => {
  // Bind user identity and custom tags to the active request scope
  setUser({ id: req.params.userId, email: `user_${req.params.userId}@example.com` })
  setTag('subscription_plan', 'pro')

  addBreadcrumb({
    category: 'database',
    message: 'Querying user record from database',
    level: 'info',
  })

  res.json({
    userId: req.params.userId,
    name: 'Alice Developer',
    role: 'Engineer',
  })
})

// Route 2: POST route with JSON body validation
app.post('/api/checkout', async (req, res, next) => {
  const { amount, currency } = req.body

  if (!amount || amount <= 0) {
    // Return standard client errors without crashing
    return res.status(400).json({ error: 'Invalid amount' })
  }

  try {
    // Simulated business logic
    res.status(201).json({ status: 'payment_processed', amount })
  } catch (err) {
    // In Express 4, pass async errors to next(err) so expressErrorHandler catches them
    next(err)
  }
})

// Route 3: Error simulation
app.get('/api/fail', () => {
  throw new Error('Simulated internal server exception')
})

// 2. MUST BE REGISTERED AFTER ALL ROUTES (Catches unhandled errors passed to next(err))
app.use(expressErrorHandler())

app.listen(3000, () => console.log('Express application listening on port 3000'))
```

---

### 6.2 Fastify Application

Fastify does not use traditional Express middleware. Use the official **`lynktraceFastifyPlugin`**:

```typescript
import Fastify from 'fastify'
import { init, lynktraceFastifyPlugin } from '@lynktrace/node'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'fastify-service',
})

const app = Fastify({ logger: true })

// Register the LynkTrace plugin before route definitions
await app.register(lynktraceFastifyPlugin, {
  ignorePaths: ['/healthz'],
})

// Define routes
app.get('/api/items/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  return { itemId: id, status: 'available' }
})

app.post('/api/items', async (request, reply) => {
  const body = request.body
  return reply.code(201).send({ created: true, data: body })
})

// Fastify handles errors cleanly; uncaught errors are reported to LynkTrace automatically
app.get('/api/error', async () => {
  throw new Error('Fastify route failure')
})

await app.listen({ port: 3000, host: '0.0.0.0' })
```

---

### 6.3 NestJS Application

In NestJS, configure the SDK in your `main.ts` using global middleware and exception filters:

```typescript
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { init, lynktraceMiddleware, captureException } from '@lynktrace/node'
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common'

// 1. Initialize SDK before NestFactory creates the application
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'nestjs-enterprise-service',
})

// 2. Global Exception Filter to forward 5xx server errors
@Catch()
export class LynkTraceExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse()
    const status = exception instanceof HttpException 
      ? exception.getStatus() 
      : HttpStatus.INTERNAL_SERVER_ERROR

    if (status >= 500) {
      captureException(exception)
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      message: (exception as any)?.message ?? 'Internal Server Error',
    })
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  
  // Attach LynkTrace request capture middleware globally
  app.use(lynktraceMiddleware({ ignorePaths: ['/health'] }))
  
  // Attach global exception filter
  app.useGlobalFilters(new LynkTraceExceptionFilter())
  
  await app.listen(3000)
}
bootstrap()
```

---

### 6.4 Serverless & AWS Lambda (`wrapHandler`)

In AWS Lambda and serverless functions, the Node.js event loop freezes immediately when the callback finishes. Wrapping your handler with **`wrapHandler`** sets `callbackWaitsForEmptyEventLoop = false` and guarantees in-memory HTTP flushing before container suspension:

```typescript
import { init, wrapHandler } from '@lynktrace/node'

// Initialize once during Lambda cold start (outside the handler)
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'payment-processor-lambda',
  // CRITICAL FOR SERVERLESS: Disable disk storage because filesystems are read-only or ephemeral
  offlineQueue: false,
})

// Wrap your exported handler
export const handler = wrapHandler(async (event: any, context: any) => {
  const orderId = event.pathParameters?.id

  if (!orderId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing orderId' }),
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, orderId }),
  }
}, {
  flushTimeoutMs: 1500, // Maximum ms to wait for telemetry flush before returning
  captureErrors: true,  // Automatically captures unhandled handler exceptions
})
```

---

### 6.5 Background Workers & Job Queues (BullMQ / CLI)

When processing asynchronous jobs, wrap execution inside **`withBackgroundSpan`** to decouple the job's trace from any dead HTTP request scopes, and always call **`await flush()`** on process shutdown:

```typescript
import { init, withBackgroundSpan, captureException, flush } from '@lynktrace/node'
import { Worker } from 'bullmq'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'queue-worker',
})

const worker = new Worker('notifications', async (job) => {
  return withBackgroundSpan(`Job ${job.name}`, async (span) => {
    span.setAttribute('job.id', job.id!)
    span.setAttribute('job.attempt', job.attemptsMade)

    try {
      // Process notification job...
      console.log(`Processing job ${job.id}`)
    } catch (err) {
      captureException(err)
      throw err // Re-throw for BullMQ retry policy
    }
  })
})

// Graceful container shutdown
process.on('SIGTERM', async () => {
  await worker.close()
  await flush(3000) // Flush remaining events with 3s deadline
  process.exit(0)
})
```

---

## 7. Zero-Code Preload & Process Bootstrap (`register.ts`)

The SDK provides `@lynktrace/node/register` as a zero-code entrypoint. 

### What `register.ts` Does Internally:
1. Calls `registerEsmLoaderHooks()` to register `import-in-the-middle` synchronization hooks with the Node.js V8 runtime.
2. Calls `registerBootstrapAutoInstrumentations()` to patch modules (`http`, `https`, `pg`, `mysql2`, `redis`, `mongodb`, `bullmq`, `prisma`, `axios`) before application files import them.
3. Does **not** read your API key or start network transport yet—it prepares the runtime so that when `await init({ apiKey })` is called, all hooks are cleanly upgraded to the live tracer.

---

## 8. SDK Initialization (`init`) & Complete Options Reference

### Complete `init()` Options Reference

```typescript
import { init } from '@lynktrace/node'

await init({
  // Required: API key issued by LynkTrace (or set env LYNKTRACE_API_KEY)
  apiKey: 'lynktrace_live_xxxxxxxxxxxx',

  // Application Identity
  applicationName: 'user-service',      // Default: package.json name
  applicationVersion: '3.1.1',           // Default: package.json version
  environment: 'production',             // Default: process.env.NODE_ENV ?? 'development'
  release: '3.1.1+commit.7a8b9c',        // Deployment release tag

  // Lifecycle & Timeouts
  initTimeoutMs: 3000,                   // Startup request deadline in ms
  initRetries: 2,                        // Max retries for transient startup failures
  shutdownTimeoutMs: 5000,               // Graceful shutdown flush deadline

  // Error Handling Behavior
  exitOnUncaughtException: true,         // Terminates process on uncaughtException after flush
  crashTimeoutMs: 2000,                  // Flush timeout during fatal crash

  // Debugging & Diagnostics
  debug: false,                          // Enables verbose SDK internal logs
  logLevel: 'info',                      // 'debug' | 'info' | 'warning' | 'error' | 'fatal'

  // Persistent Offline Queue (Disk Storage)
  offlineQueue: true,                    // Set to false for Serverless/Lambda/Read-only disks
  // Or pass custom disk limits:
  // offlineQueue: {
  //   maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB per file
  //   maxEvents: 10000,
  //   directory: '/tmp/telemetry-events',
  // },

  // Event Filtering & Mutation Hooks
  beforeSend: (event) => {
    // Returning null drops the event from being transmitted:
    if (event.type === 'error' && event.error?.message?.includes('ETIMEDOUT')) {
      return null
    }
    return event
  },

  beforeBreadcrumb: (breadcrumb) => {
    // Scrub sensitive tokens from breadcrumbs:
    if (breadcrumb.data?.token) delete breadcrumb.data.token
    return breadcrumb
  },
})
```

### Fail-Open Initialization & Recovery Invariants
1. **Control Plane Independence**: If the remote config endpoint (`/v1/init`) returns `500`, `503`, or times out, `init()` **never throws**. The SDK activates safe internal defaults and launches a background recovery worker.
2. **Zero Request Path Blocking**: Incoming customer requests are served immediately; initialization failures never stall the event loop or prevent the server from binding ports.
3. **Automatic Reconnect**: When the control plane recovers, the SDK transparently switches to the authoritative remote configuration.

---

## 9. Feature Guides & Workload Profiles

### Recommended Profile by Workload

| Workload Type | Tracing | Error Tracking | Request Capture | Metrics | Logging | Profiling | Offline Disk Queue | Recommended Batching |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| **Standard SaaS Web App** | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On | Optional (5% sample) | ✅ On | Standard (50 err / 500 spans / 2s flush) |
| **High-Throughput Microservice ($> 10\text{k req/s}$)** | ✅ On (adaptive) | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On (15s cooling duty) | ✅ On | High-throughput (1000 spans / 2.5s flush) |
| **Serverless (AWS Lambda / Vercel)** | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On | ❌ Off | ❌ **Off** (`offlineQueue: false`) | Instant (1 err / 25 spans / 250ms flush) |
| **Batch Workers / Job Queues** | ✅ Background | ✅ On | ❌ Off | ✅ On | ✅ On | Optional | ✅ On | Standard |
| **Read-Only Container Filesystems** | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On | Optional | ❌ **Off** (or mount `/tmp`) | Standard |

### Disabling Subsystems Locally and Remotely

Subsystems can be enabled or disabled via Remote Configuration in the LynkTrace Web Console without redeploying code:

```json
{
  "features": {
    "tracing": true,
    "errors": true,
    "requests": true,
    "metrics": true,
    "logging": false,
    "profiling": false,
    "crons": true,
    "runtimeMetrics": true,
    "gcMonitoring": true,
    "eventLoopMonitoring": true
  }
}
```

### Disabling Disk Storage for Serverless & Read-Only Disks

In AWS Lambda, Cloud Run, or environments with read-only root filesystems (`EROFS`), pass `offlineQueue: false`:

```typescript
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  offlineQueue: false, // Disables SQLite/NDJSON disk writes completely
})
```

### Emergency Operational Killswitches

The control plane can instantly disable telemetry in production during incidents:
- `killswitches.disableTransport: true` (Drops all outgoing HTTP transport)
- `killswitches.disableProfiling: true` (Stops all V8 CPU & Heap samplers)
- `killswitches.disableTracing: true` (Turns off span generation)
- `killswitches.disableErrors: true` (Silences exception capture)

---

## 10. Core Features & Capabilities

### A. Error Tracking & Exception Capture

```typescript
import { captureException, captureMessage, setTag, setUser } from '@lynktrace/node'

setUser({ id: 'user_9921', email: 'alex@example.com' })
setTag('customer_tier', 'enterprise')

try {
  throw new Error('Database connection timeout')
} catch (error) {
  // Captures stack trace, source code context lines before/after,
  // request headers, user context, breadcrumbs, and active trace ID:
  captureException(error, {
    level: 'fatal',
    extra: { query: 'SELECT * FROM orders', retries: 3 },
  })
}
```

### B. Distributed Tracing & W3C Context Propagation

Traces conform to W3C `traceparent` standards and propagate automatically across HTTP calls, message queues, and database drivers:

```typescript
import { getTraceId, getSpanId } from '@lynktrace/node'

const traceId = getTraceId()
const spanId = getSpanId()
console.log(`Current Trace ID: ${traceId}, Span ID: ${spanId}`)
```

### C. Custom Spans & Database Query Attribution

```typescript
import { withSpan, withDbSpan } from '@lynktrace/node'

// Custom application span
const result = await withSpan('calculateMonthlyInvoice', async (span) => {
  span.setAttribute('invoice.customer_id', 42)
  return computeInvoice()
})

// Database query span with truthful exclusive timing attribution
const rows = await withDbSpan({
  system: 'postgresql',
  statement: 'SELECT * FROM users WHERE active = $1',
  operation: 'SELECT',
  table: 'users',
}, async () => {
  return pgPool.query('SELECT * FROM users WHERE active = $1', [true])
})
```

### D. Detached Background Task Tracing (`withBackgroundSpan`)

When executing background jobs that outlive the incoming HTTP request, standard `AsyncLocalStorage` can cause memory leaks or orphaned children. Use `withBackgroundSpan` to create an independent root trace:

```typescript
import { withBackgroundSpan } from '@lynktrace/node'

void withBackgroundSpan('generatePdfReport', async (span) => {
  span.setAttribute('report.format', 'pdf')
  await renderPdf()
})
```

### E. OpenTelemetry Metrics & Exponential Histograms

Built on the native OpenTelemetry Metrics SDK with $O(1)$ exponential histogram bucket aggregation:

```typescript
import { captureMetric, incrementCounter, recordHistogram, setGauge } from '@lynktrace/node'

// Increment a counter
incrementCounter('api.requests.total', 1, { route: '/checkout', status: '200' })

// Record high-precision latency into exponential histogram views
recordHistogram('api.checkout.duration_ms', 142.5, { currency: 'USD' })

// Update a gauge
setGauge('queue.pending_jobs', 18, { queue_name: 'high-priority' })
```

### F. V8 CPU & Heap Profiling with Duty-Cycle Cooling

The SDK features built-in V8 CPU and Heap profiling driven by the Node.js inspector session:

```typescript
import { startProfile, stopProfile, startHeapProfile, stopHeapProfile } from '@lynktrace/node'

// Start CPU sampling
await startProfile('checkout-spike')
// ... heavy computation ...
await stopProfile('checkout-spike')

// Start Heap sampling
await startHeapProfile('memory-audit')
// ... memory allocations ...
await stopHeapProfile('memory-audit')
```

#### Continuous CPU Profiling with Duty-Cycle Cooling
Continuous profiling samples the process in recurring chunks without accumulating overhead:

```json
{
  "profiling": {
    "continuous": true,
    "continuousIntervalMs": 60000,
    "coolingIntervalMs": 15000,
    "sampleRateHz": 99
  }
}
```

### G. Hardware & Runtime Resource Monitors

The SDK automatically monitors host system health and reports runtime metrics:

#### 1. CPU Load & Throttling Monitor
Tracks core counts, load averages (1m, 5m, 15m), user/system CPU execution ticks, and detects hypervisor CPU quota throttling (e.g., in Docker, Kubernetes, or AWS ECS burstable instances).

#### 2. GPU Detector (NVIDIA & Apple Silicon)
Detects installed GPUs (NVIDIA via NVML/nvidia-smi and Apple Silicon M-series via Metal), capturing VRAM allocation, memory utilization, and GPU core temperature without external binary dependencies.

#### 3. Storage & Disk Capacity Detector
Monitors disk volume mount paths, total capacity, used bytes, available free bytes, and inode usage to warn before disk saturation compromises database or log storage.

#### 4. V8 Garbage Collection (GC) Monitor
Hooks into V8 performance observers to record Garbage Collection events:
- **Scavenge**: Minor young generation GC pauses
- **Mark-Sweep-Compact**: Major full heap collection pauses
- **Incremental & Weak Processing**: Background GC passes
- Reclaimed memory bytes and GC pressure index.

#### 5. Event Loop Delay & Lag Monitor
Uses `perf_hooks.monitorEventLoopDelay()` to calculate real-time p50, p90, p95, p99, and maximum event loop lag.

#### 6. Container Memory Pressure & Hysteresis State Machine
Computes actual container memory limits from cgroups v1 and cgroups v2, managing an adaptive pressure state machine:
- **HEALTHY** (Score $< 30$): Full telemetry capture.
- **ELEVATED** (Score $30\text{--}59$): Non-critical traces sampled down by 25%.
- **PRESSURED** (Score $60\text{--}79$): Traces sampled down by 50%, large profiles paused.
- **CRITICAL** (Score $\ge 80$): Non-critical telemetry dropped; critical reserve dedicated exclusively to fatal errors and crons.

### H. Structured Logging & Breadcrumbs

```typescript
import { captureLog, addBreadcrumb } from '@lynktrace/node'

addBreadcrumb({
  category: 'auth',
  message: 'User authenticated via OAuth2',
  level: 'info',
  data: { provider: 'github' },
})

captureLog('warn', 'Payment gateway high latency', {
  gateway: 'stripe',
  latencyMs: 3420,
})
```

### I. Cron & Scheduled Job Heartbeats (`captureCronCheckIn`)

```typescript
import { captureCronCheckIn } from '@lynktrace/node'

const startTime = Date.now()
try {
  captureCronCheckIn('nightly-database-backup', 'in_progress')
  await performBackup()
  captureCronCheckIn('nightly-database-backup', 'ok', {
    duration: Date.now() - startTime,
  })
} catch (error) {
  captureCronCheckIn('nightly-database-backup', 'error', {
    duration: Date.now() - startTime,
  })
}
```

### J. Custom Business Event Ingestion

```typescript
import { captureEvent } from '@lynktrace/node'

captureEvent({
  type: 'order_completed',
  orderId: 'ord-8831',
  amount: 249.99,
  currency: 'USD',
  timestamp: Date.now(),
})
```

---

## 11. Transport Pipeline & Resilience Guarantees

### Per-Route Queue Isolation
Every event type routes to its own dedicated queue and batch manager:
- `errors` (`/v1/errors`)
- `traces` (`/v1/traces`)
- `spans` (`/v1/spans`)
- `requests` (`/v1/requests`)
- `metrics` (`/v1/metrics`)
- `logs` (`/v1/logs`)
- `profiles` (`/v1/profiles`)
- `crons` (`/v1/crons`)
- `events` (`/v1/events`)

*Advantage*: An avalanche of 50,000 trace spans will **never** delay, drop, or block a critical fatal error or cron check-in.

### Worker Thread Serialization & Event Loop Protection
Batches exceeding `transport.workerOffloadThresholdBytes` (default: $50\text{KB}$) and all profile batches are offloaded to background worker threads (`SerializationPool`).
- Heavy profiles are forbidden from main-thread stringification fallback.
- If worker threads are busy or time out, profiles drop cleanly with `reason: 'serialization_failed'`, guaranteeing zero event loop freeze.

### Strict LRU Retry Bookkeeping
- Retried events update their access order in `firstAttemptTimestamps`.
- When retry tracking reaches capacity ($5,000$ entries), least-recently-used keys are evicted first, keeping active retry pipelines intact.

### Circuit Breakers & Exponential Backoff
- Per-route circuit breakers trip after consecutive HTTP 5xx errors or network drops.
- Retries follow exponential backoff with full jitter to avoid thundering herd spikes.

### Offline Disk Spooling & Deduplication
- During persistent network outages, undelivered events spool to disk in bounded NDJSON journals.
- Upon reconnection, events replay automatically with `X-LynkTrace-Replay: true` headers so the backend can deduplicate by `eventId`.

---

## 12. Privacy, PII Scrubbing & Security

The SDK features a multi-tiered security and PII scrubber:
- **Luhn Mod-10 Algorithm**: Automatically redacts Visa, Mastercard, American Express, and Discover PAN numbers.
- **Secrets & Credentials**: Automatically masks Social Security Numbers (SSN), AWS Access Keys, Stripe Secret Keys, JWT tokens, and Bearer authorization headers.
- **Deep Cycle Protection**: Recursively sanitizes nested objects up to configurable `privacy.scrubbing.maxDepth` (default: 10 levels deep) without stack overflows or circular reference crashes.

---

## 13. Complete API Reference

| Exported Symbol | Signature | Purpose |
|---|---|---|
| `init(options)` | `(options: SDKInitOptions) => Promise<RemoteConfigResponse>` | Initializes the SDK and connects to control plane. |
| `shutdown(timeoutMs?)` | `(timeoutMs?: number) => Promise<ShutdownResult>` | Gracefully flushes and closes process resources. |
| `flush(timeoutMs?)` | `(timeoutMs?: number) => Promise<void>` | Flushes all in-memory queues without terminating. |
| `captureException(error, options?)` | `(error: unknown, options?: CaptureOptions) => EventReceipt` | Captures handled or unhandled exceptions. |
| `captureMessage(message, level?)` | `(message: string, level?: SeverityLevel) => EventReceipt` | Captures an informational message event. |
| `captureEvent(event)` | `(event: SDKEvent \| Event) => EventReceipt` | Ingests canonical or custom business events. |
| `captureLog(level, message, data?)` | `(level: LogLevel, message: string, data?: object) => void` | Ingests structured log telemetry. |
| `captureMetric(metric)` | `(metric: MetricEvent) => void` | Ingests metric counter, gauge, or histogram. |
| `captureCronCheckIn(slug, status, opt?)` | `(slug: string, status: CronStatus, opt?: object) => void` | Ingests cron job heartbeat check-ins. |
| `startProfile(id?)` | `(id?: string) => Promise<boolean>` | Starts a single-shot V8 CPU profile. |
| `stopProfile(id?)` | `(id?: string) => Promise<void>` | Stops CPU profile and emits profile event. |
| `startHeapProfile(id?)` | `(id?: string) => Promise<boolean>` | Starts V8 sampling heap allocation profile. |
| `stopHeapProfile(id?)` | `(id?: string) => Promise<void>` | Stops heap profile and emits profile event. |
| `withSpan(name, fn, options?)` | `<T>(name: string, fn: (span) => Promise<T>, opt?) => Promise<T>` | Wraps async logic in an OpenTelemetry span. |
| `withSpanSync(name, fn, options?)` | `<T>(name: string, fn: (span) => T, opt?) => T` | Synchronous version of `withSpan`. |
| `withDbSpan(options, fn)` | `<T>(options: DbSpanOptions, fn: (span) => Promise<T>) => Promise<T>` | Wraps database queries with query sanitization. |
| `withBackgroundSpan(name, fn)` | `<T>(name: string, fn: (span) => Promise<T>) => Promise<T>` | Detached root span for background jobs. |
| `wrapHandler(handler, options?)` | `<TEvent, TResult>(handler: Handler, opt?) => Handler` | Serverless AWS Lambda / Cloud Function wrapper. |
| `lynktraceMiddleware(options?)` | `(options?: LynkTraceExpressOptions) => RequestHandler` | Express request and context binding middleware. |
| `expressErrorHandler()` | `() => ErrorRequestHandler` | Express unhandled route error middleware (4 args). |
| `lynktraceExpressErrorHandler` | Alias to `expressErrorHandler()` | Express unhandled route error middleware alias. |
| `lynktraceFastifyPlugin` | `FastifyPluginAsync` | Fastify request and error capture plugin. |
| `setUser(user)` | `(user: UserIdentity \| null) => void` | Binds user context to active scope. |
| `setTag(key, value)` | `(key: string, value: string) => void` | Binds custom tag to active scope. |
| `addBreadcrumb(crumb)` | `(crumb: Breadcrumb) => void` | Records navigation/action breadcrumb. |
| `getTraceId()` | `() => string \| undefined` | Returns current active W3C trace ID. |
| `getSpanId()` | `() => string \| undefined` | Returns current active span ID. |

---

## 14. Graceful Shutdown & Kubernetes Lifecycle

In containerized environments (Kubernetes, ECS), handle `SIGTERM` and `SIGINT` signals to flush buffered telemetry before termination:

```typescript
import { shutdown } from '@lynktrace/node'

const handleSignal = async (signal: string) => {
  console.log(`Received ${signal}, shutting down gracefully...`)
  const result = await shutdown(3000) // 3 second deadline
  console.log(`Telemetry shutdown complete: timedOut=${result.timedOut}`)
  process.exit(0)
}

process.on('SIGTERM', () => handleSignal('SIGTERM'))
process.on('SIGINT', () => handleSignal('SIGINT'))
```

---

## 15. Troubleshooting & Production Best Practices

### 1. Events Not Appearing in Dashboard
- Verify your API key starts with `lynktrace_live_` or `lynktrace_test_`.
- Check if `debug: true` is enabled in `init()` to view console diagnostic logs.
- Confirm outbound network egress to `https://api.lynktrace.com` on port `443` is permitted.

### 2. Missing Database Spans in ESM
- Ensure you launch Node with `node --import @lynktrace/node/register dist/server.js` or set `NODE_OPTIONS="--import @lynktrace/node/register"`.
- This ensures database client drivers (`pg`, `mysql2`, `ioredis`) are intercepted before module evaluation.

### 3. AWS Lambda Container Freezes
- Ensure you wrap handlers with `wrapHandler(handler, { flushTimeoutMs: 1500 })`.
- Ensure `offlineQueue: false` is configured in `init()` for Lambda functions.

### 4. Memory Bounding in High-Throughput Services
- The SDK limits per-route in-memory queues to 10,000 events ($10\text{MB}$ total). Under extreme load bursts, the dual ring buffer safely drops oldest non-critical events while preserving critical errors and crons.

---

**© 2026 LynkTrace. All rights reserved. Enterprise observability with fail-open guarantees.**
