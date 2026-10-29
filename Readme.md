# @lynktrace/node

> Observability SDK for Node.js with optional auto-instrumentation, error capture, distributed tracing, metrics, structured logs, profiling and a bounded offline queue.

[![Version](https://img.shields.io/badge/version-3.3.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)]()
[![Module System](https://img.shields.io/badge/module-ESM%20%7C%20CJS%20dynamic%20import-orange.svg)]()
[![Runtime](https://img.shields.io/badge/runtime-Node.js-purple.svg)]()
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](package.json)

---

## Table of Contents

- [1. Overview & Architecture](#1-overview--architecture)
- [2. System Requirements & Runtime Compatibility](#2-system-requirements--runtime-compatibility)
- [3. Installation Across Package Managers (npm, pnpm, yarn, bun)](#3-installation-across-package-managers-npm-pnpm-yarn-bun)
- [4. Choose an Integration Method](#4-choose-an-integration-method)
- [5. Recommended Setup by Module System & Runtime](#5-recommended-setup-by-module-system--runtime)
  - [5.1 Modular JavaScript (ESM — `import`)](#51-modular-javascript-esm--import)
  - [5.2 CommonJS Applications (`.cjs` / CommonJS TypeScript)](#52-commonjs-applications-cjs--commonjs-typescript)
  - [5.3 Bun Runtime (Unverified)](#53-bun-runtime-unverified)
  - [5.4 TypeScript Development Tooling (`tsx` & `ts-node`)](#54-typescript-development-tooling-tsx--ts-node)
  - [5.5 Docker & Container Environments](#55-docker--container-environments)
  - [5.6 Kubernetes Deployments](#56-kubernetes-deployments)
- [6. Complete Framework Integration Guides & Route Snippets](#6-complete-framework-integration-guides--route-snippets)
  - [6.1 Express.js Application (ESM & CJS)](#61-expressjs-application-esm--cjs)
  - [6.2 Fastify Application](#62-fastify-application)
  - [6.3 NestJS Application](#63-nestjs-application)
  - [6.4 Serverless & AWS Lambda (`wrapHandler`)](#64-serverless--aws-lambda-wraphandler)
  - [6.5 Background Workers & Job Queues (BullMQ / CLI)](#65-background-workers--job-queues-bullmq--cli)
  - [6.6 Node.js Built-in HTTP Server](#66-nodejs-built-in-http-server)
  - [6.7 Other Serverless Handler Shapes](#67-other-serverless-handler-shapes)
- [7. Zero-Code Preload & Process Bootstrap (`register.ts`)](#7-zero-code-preload--process-bootstrap-registerts)
- [8. SDK Initialization (`init`) & Complete Options Reference](#8-sdk-initialization-init--complete-options-reference)
  - [Complete `init()` Options Reference](#complete-init-options-reference)
  - [Fail-Open Initialization & Recovery Invariants](#fail-open-initialization--recovery-invariants)
- [9. Feature Guides & Workload Profiles](#9-feature-guides--workload-profiles)
  - [Recommended Integration by Workload](#recommended-integration-by-workload)
  - [Remote Feature and Instrumentation Policy](#remote-feature-and-instrumentation-policy)
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
    - [2. GPU Detector](#2-gpu-detector)
    - [3. Storage & Disk Capacity Detector](#3-storage--disk-capacity-detector)
    - [4. V8 Garbage Collection (GC) Monitor](#4-v8-garbage-collection-gc-monitor)
    - [5. Event Loop Delay & Lag Monitor](#5-event-loop-delay--lag-monitor)
    - [6. Process and Container Memory Pressure](#6-process-and-container-memory-pressure)
  - [H. Enterprise Structured Logging & Integrations](#h-enterprise-structured-logging--integrations)
  - [I. Cron & Scheduled Job Heartbeats (`captureCronCheckIn`)](#i-cron--scheduled-job-heartbeats-capturecroncheckin)
  - [J. Custom Business Event Ingestion](#j-custom-business-event-ingestion)
- [11. Transport Pipeline & Delivery Behavior](#11-transport-pipeline--delivery-behavior)
  - [Per-Route Queue Isolation](#per-route-queue-isolation)
  - [Worker Thread Serialization & Event Loop Protection](#worker-thread-serialization--event-loop-protection)
  - [Bounded Retry Bookkeeping](#bounded-retry-bookkeeping)
  - [Circuit Breakers & Backoff](#circuit-breakers--backoff)
  - [Offline Disk Spooling & Deduplication](#offline-disk-spooling--deduplication)
- [12. Privacy, PII Scrubbing & Security](#12-privacy-pii-scrubbing--security)
- [13. Complete API Reference](#13-complete-api-reference)
- [14. Graceful Shutdown & Kubernetes Lifecycle](#14-graceful-shutdown--kubernetes-lifecycle)
- [15. Troubleshooting & Production Best Practices](#15-troubleshooting--production-best-practices)

---

## 1. Overview & Architecture

`@lynktrace/node` is designed to keep telemetry failures isolated from normal application paths. Capture and instrumentation paths use defensive error handling; initialization, network delivery, disk access, and graceful shutdown are still subject to runtime limits and can fail or time out. Treat telemetry delivery as best-effort and monitor the SDK health snapshot where delivery visibility matters.

```
Application code
  ├─ framework middleware / auto-instrumentation
  └─ manual capture APIs and spans
          │
          ▼
Context and scope enrichment
  (AsyncLocalStorage, W3C trace context, user/tags/breadcrumbs)
          │
          ▼
Event processing
  (processors, privacy policy, filtering, sampling and limits)
          │
          ▼
Bounded in-memory queues and per-route transport
  ├─ optional worker serialization/compression
  ├─ network send with retry/backoff behavior
  └─ optional bounded disk persistence and replay
```

---

## 2. System Requirements & Runtime Compatibility

- **Node.js**: `>= 18.0.0` for the documented SDK API baseline. ESM loader interception needs `--import` and `node:module.register`; use Node `>= 18.19.0` or `>= 20.6.0` for that path. The package ships ESM JavaScript.
- **Bun**: Runtime compatibility and Node-specific loader instrumentation are not declared in package metadata; validate Bun deployments with the integrations you plan to use.
- **Operating systems and containers**: Use a supported Node.js runtime. Host metrics, filesystem access and loader behavior vary by OS, container permissions and provider.
- **Deployment models**: Long-lived Node processes and serverless function handlers can use the APIs described here. There is no provider-specific Vercel, Google Cloud Functions or Netlify adapter in this package.
- **Module Systems**: ESM imports are the native package format. CommonJS applications can use dynamic `import()`; the package does not ship a separate CommonJS build. `require()` of ESM is only supported by newer Node releases and only for synchronous module graphs.
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

### Optional Integration Packages

`@prisma/client` (`^7`) and `bullmq` (`^2` through `^6`) are optional peer dependencies. Install the database, queue or messaging clients your application uses (`pg`, `mysql2`, `mongodb`, `ioredis`, `redis`, `kafkajs`, `amqplib`, and others) in the application itself. Instrumentation only applies to compatible installed versions and is governed by remote config.

---

## 4. Choose an Integration Method

| Need | Recommended integration |
|---|---|
| Instrument supported database, HTTP-client or messaging dependencies | Start with `node --import @lynktrace/node/register ...` so hooks load before application dependencies. |
| Express request context and errors | Install `lynktraceMiddleware()` before parsers/routes and `expressErrorHandler()` after routes. |
| Fastify request context and errors | Register `lynktraceFastifyPlugin` before routes. |
| Custom business operations or unsupported clients | Add `withSpan()` / `withDbSpan()` around meaningful work; avoid adding spans around calls already auto-instrumented. |
| CommonJS application | Use `import()` from CJS. Use the ESM `--import` preload for early hooks; do not use `-r`. |

### Approach A: Auto-Instrumentation (Recommended when the libraries are supported)
- **How to run**: `node --import @lynktrace/node/register dist/server.js` on Node `>=18.19.0` or `>=20.6.0`.
- **Why**: The preload installs hooks before application dependencies load, which is important for ESM libraries and early module patches.
- **Result**: Configured, entitled instrumentations can create spans for supported libraries. Coverage depends on the library, its version, module format, remote configuration, and whether it was loaded before the hooks.

### Approach B: Framework Middleware or Plugin
- **How to run**: `node dist/server.js` after installing the framework middleware/plugin.
- **Why**: Use this when you want framework request context and request capture without depending on a preload for every instrumentation.
- **Important**: Importing the SDK root also installs early bootstrap hooks. If the SDK is imported after an instrumented ESM dependency, that dependency may already have loaded; use the preload when you need early interception. Middleware/plugin behavior and HTTP spans are controlled by remote configuration and can overlap with auto-instrumentation, so validate that your selected combination does not duplicate request events.

---

## 5. Recommended Setup by Module System & Runtime

### 5.1 Modular JavaScript (ESM — `import`)

In modern Node.js using ECMAScript Modules (`"type": "module"` in `package.json` or `.mjs` files), static `import` statements are hoisted by the JavaScript engine before top-level code executes.

The package is published as ESM. For early auto-instrumentation hooks, preload it before importing frameworks and database clients. `--import` is available in Node 18.18+; the SDK's ESM loader-hook fallback is available from Node 18.19+ or 20.6+. On earlier Node 18 releases, use the SDK APIs and framework middleware, but do not expect ESM dependency interception.

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

### 5.2 CommonJS Applications (`.cjs` / CommonJS TypeScript)

The package has `"type": "module"` and its `require` export points to the ESM entrypoint; it does not ship a separate CommonJS build. Use dynamic `import()` from CommonJS so startup works across the documented Node range. Do not use `node -r @lynktrace/node/register`: `-r` loads CommonJS modules, while this preload is ESM.

For early instrumentation, run the CommonJS application with Node's ESM preload flag (Node 18.18+):

```bash
node --import @lynktrace/node/register dist/server.cjs
```

```json
{
  "scripts": {
    "start": "node --import @lynktrace/node/register dist/server.cjs"
  }
}
```

Application example (`server.cjs`):

```javascript
const express = require('express')

async function start() {
  const { init, lynktraceMiddleware, expressErrorHandler } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'billing-service' })

  const app = express()
  app.use(lynktraceMiddleware())
  app.use(express.json())
  app.get('/api/invoices', (_req, res) => res.json({ invoices: [] }))
  app.use(expressErrorHandler())
  app.listen(8080, '0.0.0.0')
}

start().catch(error => {
  console.error('Application startup failed', error)
  process.exitCode = 1
})
```

Recent Node releases can synchronously `require()` some ESM modules, but that feature is version-dependent and fails for asynchronous ESM dependency graphs. Dynamic `import()` is the portable CommonJS integration.

---

### 5.3 Bun Runtime (Unverified)

This package targets Node.js, and Bun compatibility is not declared in package metadata. Do not assume Node loader hooks or auto-instrumentation work in Bun. If evaluating Bun, start with direct ESM import plus framework middleware, and validate each dependency/runtime combination before production use.

#### Installation:
```bash
bun add @lynktrace/node
```

#### ESM application (`server.ts`):
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

CommonJS source may use dynamic `import()` only where Bun's current execution mode supports it. No Bun-specific CommonJS/preload recipe is guaranteed by this SDK.

Best-effort CommonJS-shaped example (validate in your Bun version before deployment):

```javascript
const express = require('express')
async function start() {
  const { init, lynktraceMiddleware, expressErrorHandler } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'bun-service' })
  const app = express()
  app.use(lynktraceMiddleware())
  app.get('/ping', (_req, res) => res.send('pong'))
  app.use(expressErrorHandler())
  app.listen(4000, '0.0.0.0')
}
start().catch(error => { console.error(error); process.exitCode = 1 })
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

#### CommonJS TypeScript:
Use `.cts` files with TypeScript `module` and `moduleResolution` set to `NodeNext`, so emitted CommonJS retains the native dynamic import. Preload the SDK with Node's `--import` flag if early instrumentation is needed; do not use `ts-node -r` or `node -r` for this ESM package.

```typescript
import express = require('express')

async function start() {
  const { init, lynktraceMiddleware, expressErrorHandler } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'typescript-cjs-api' })
  const app = express()
  app.use(lynktraceMiddleware())
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.use(expressErrorHandler())
  app.listen(3000, '0.0.0.0')
}

start().catch(error => { console.error(error); process.exitCode = 1 })
```

---

### 5.5 Docker & Container Environments

In containerized deployments, `NODE_OPTIONS` can preload the SDK before the entrypoint and for child Node processes that inherit the environment. The preload requires a supported Node version and can be omitted when the application registers instrumentation explicitly:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

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
  selector:
    matchLabels:
      app: order-api
  template:
    metadata:
      labels:
        app: order-api
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: order-api
          image: myregistry.azurecr.io/order-api:v3.3.0
          ports:
            - containerPort: 3000
          env:
            - name: NODE_OPTIONS
              value: "--import @lynktrace/node/register"
            - name: LYNKTRACE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: lynktrace-secrets
                  key: api-key
```

---

## 6. Complete Framework Integration Guides & Route Snippets

### 6.1 Express.js Application (ESM & CJS)

Express integration requires mounting two middlewares in exact order:
1. `lynktraceMiddleware()` as the **very first middleware**.
2. `expressErrorHandler()` as the **very last middleware**.

**Recommended:** use the preload for early database/client instrumentation, then install the request middleware before parsers and routes. Keep the terminal error middleware after all routes. The Express options accepted by this SDK are `ignorePaths`, `ignoreMethods`, `maxBreadcrumbs`, `trustedProxies`, `instrumentMiddleware`, `minMiddlewareDurationMs`, and `ignoreMiddlewares`; only pass options declared by `LynkTraceExpressOptions` in your installed version.

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

#### CommonJS (`server.cjs`)

Use dynamic `import()` for the SDK; use `--import @lynktrace/node/register` at process startup when early auto-instrumentation is needed.

```javascript
const express = require('express')

async function start() {
  const { init, lynktraceMiddleware, expressErrorHandler } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'express-sample' })
  const app = express()
  app.use(lynktraceMiddleware({ ignorePaths: ['/health', '/metrics'] }))
  app.use(express.json())
  app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }))
  app.use(expressErrorHandler())
  app.listen(3000, '0.0.0.0')
}

start().catch(error => { console.error(error); process.exitCode = 1 })
```

For Express 4, explicitly pass rejected async route errors to `next(error)` (for example with an async-handler wrapper). Express 5 forwards rejected route promises to its error middleware.

---

### 6.2 Fastify Application

Fastify does not use traditional Express middleware. Use the official **`lynktraceFastifyPlugin`**:

**Recommended:** register the plugin before routes. Leave `captureValidationErrors` off unless 422 validation failures are operationally useful; normal 4xx responses such as 401 and 404 are not exceptions.

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
  // Optional: report schema-validation responses with HTTP 422.
  // HTTP 401 and 404 responses are treated as expected client outcomes.
  captureValidationErrors: false,
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

#### CommonJS (`server.cjs`)

```javascript
const Fastify = require('fastify')

async function start() {
  const { init, lynktraceFastifyPlugin } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'fastify-service' })
  const app = Fastify({ logger: true })
  await app.register(lynktraceFastifyPlugin, { ignorePaths: ['/healthz'], captureValidationErrors: false })
  app.get('/api/items/:id', async request => ({ itemId: request.params.id }))
  await app.listen({ port: 3000, host: '0.0.0.0' })
}

start().catch(error => { console.error(error); process.exitCode = 1 })
```

---

### 6.3 NestJS Application

Initialize before `NestFactory.create()`, then install the request middleware before Nest routes. If a custom global exception filter takes ownership of errors, report only server failures there; do not add an explicit capture for errors that another LynkTrace integration already reports.

```typescript
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { init, lynktraceMiddleware, captureException } from '@lynktrace/node'
import { Catch, HttpException, HttpAdapterHost, HttpStatus } from '@nestjs/common'
import type { ExceptionFilter, ArgumentsHost } from '@nestjs/common'

// 1. Initialize SDK before NestFactory creates the application
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'nestjs-enterprise-service',
})

// 2. Global Exception Filter to forward 5xx server errors
@Catch()
export class LynkTraceExceptionFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse()
    const status = exception instanceof HttpException 
      ? exception.getStatus() 
      : HttpStatus.INTERNAL_SERVER_ERROR

    if (status >= 500) {
      captureException(exception)
    }

    const body = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      message: (exception as any)?.message ?? 'Internal Server Error',
    }
    this.adapterHost.httpAdapter.reply(response, body, status)
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  
  // Attach LynkTrace request capture middleware globally
  app.use(lynktraceMiddleware({ ignorePaths: ['/health'] }))
  
  // Attach global exception filter
  app.useGlobalFilters(new LynkTraceExceptionFilter(app.get(HttpAdapterHost)))
  
  await app.listen(3000)
}
bootstrap()
```

#### CommonJS (`main.cjs`)

This form assumes the Nest application module is emitted as CommonJS (`app.module.cjs`, for example from a `.cts` source file). Use `node --import @lynktrace/node/register dist/main.cjs` when early auto-instrumentation is needed.

```javascript
const { NestFactory } = require('@nestjs/core')
const { HttpAdapterHost, HttpException, HttpStatus } = require('@nestjs/common')
const { AppModule } = require('./app.module.cjs')

async function bootstrap() {
  const { init, lynktraceMiddleware, captureException } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'nestjs-service' })
  const app = await NestFactory.create(AppModule)
  app.use(lynktraceMiddleware({ ignorePaths: ['/health'] }))
  const adapterHost = app.get(HttpAdapterHost)
  app.useGlobalFilters({
    catch(exception, host) {
      const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
      if (status >= 500) captureException(exception)
      adapterHost.httpAdapter.reply(host.switchToHttp().getResponse(), {
        statusCode: status,
        message: exception && typeof exception === 'object' && 'message' in exception ? exception.message : 'Internal Server Error',
      }, status)
    },
  })
  await app.listen(3000, '0.0.0.0')
}

bootstrap().catch(error => { console.error(error); process.exitCode = 1 })
```

---

### 6.4 Serverless & AWS Lambda (`wrapHandler`)

For AWS Lambda's event/context handler shape, initialize once during cold start and wrap the exported handler. The wrapper sets `callbackWaitsForEmptyEventLoop = false` when supported and makes a best-effort flush for up to `flushTimeoutMs`; this is a bounded attempt, not a delivery guarantee. Disabling the offline queue avoids filesystem writes but also removes disk buffering during outages.

```typescript
import { init, wrapHandler } from '@lynktrace/node'

// Initialize once during Lambda cold start (outside the handler)
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'payment-processor-lambda',
  // Optional: disable disk buffering only if its outage protection is not needed
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

#### CommonJS (`handler.cjs`)

```javascript
const sdkReady = import('@lynktrace/node').then(async sdk => {
  await sdk.init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'payment-processor' })
  return sdk.wrapHandler(async (event, context) => ({
    statusCode: 200,
    body: JSON.stringify({ requestId: context.awsRequestId, accepted: true }),
  }), { flushTimeoutMs: 1500, captureErrors: true })
})

exports.handler = async (event, context) => (await sdkReady)(event, context)
```

For HTTP-style function providers, use the provider's documented `(request, response)` handler or your Express/Fastify integration. Do not wrap an Express application with `wrapHandler`: the SDK's wrapper supports event/context handlers and uses the handler's arity to detect callback-style functions.

---

### 6.5 Background Workers & Job Queues (BullMQ / CLI)

When processing asynchronous jobs, wrap each job in **`withBackgroundSpan`** so it owns a root trace. On shutdown, stop accepting work, close the worker and then await `shutdown()` so the SDK can drain and release its resources.

```typescript
import { init, withBackgroundSpan, captureException, shutdown } from '@lynktrace/node'
import { Worker } from 'bullmq'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'queue-worker',
  handleSignals: false, // This example owns SIGTERM/SIGINT and shutdown ordering
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

// Graceful container shutdown; avoid process.exit() so pending close callbacks can run.
let stopPromise
const stop = () => {
  if (!stopPromise) stopPromise = (async () => {
    await worker.close()
    const result = await shutdown(10000)
    if (!result.completed) process.exitCode = 1
  })()
  return stopPromise
}
process.once('SIGTERM', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
process.once('SIGINT', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
```

#### CommonJS (`worker.cjs`)

```javascript
const { Worker } = require('bullmq')

async function start() {
  const { init, withBackgroundSpan, captureException, shutdown } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'queue-worker', handleSignals: false })
  const worker = new Worker('notifications', job => withBackgroundSpan(`Job ${job.name}`, async span => {
    span.setAttribute('job.id', String(job.id))
    try {
      // Process the job here, then return its result.
      return { processed: true }
    } catch (error) { captureException(error); throw error }
  }))

  let stopPromise
  const stop = () => stopPromise ??= (async () => {
    await worker.close()
    const result = await shutdown(10000)
    if (!result.completed) process.exitCode = 1
  })()
  process.once('SIGTERM', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
  process.once('SIGINT', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
}

start().catch(error => { console.error(error); process.exitCode = 1 })
```

---

### 6.6 Node.js Built-in HTTP Server

**Recommended:** preload the SDK when you need early HTTP/client instrumentation, initialize before listening, and use a custom signal handler only if the application owns shutdown ordering. Do not add both SDK and application signal handlers with `handleSignals: true`.

ESM (`server.mjs`):

```javascript
import { createServer } from 'node:http'
import { init, captureException, shutdown } from '@lynktrace/node'

await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'node-http-api', handleSignals: false })
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') { res.writeHead(200).end('ok'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (error) {
    captureException(error)
    res.writeHead(500).end('internal server error')
  }
})
server.listen(3000, '0.0.0.0')

let stopping
const stop = () => stopping ??= (async () => {
  await new Promise(resolve => server.close(resolve))
  const result = await shutdown(10000)
  if (!result.completed) process.exitCode = 1
})()
process.once('SIGTERM', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
process.once('SIGINT', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
```

CommonJS (`server.cjs`):

```javascript
const { createServer } = require('node:http')

async function start() {
  const { init, captureException, shutdown } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, applicationName: 'node-http-api', handleSignals: false })
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') { res.writeHead(200).end('ok'); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
    } catch (error) {
      captureException(error)
      res.writeHead(500).end('internal server error')
    }
  })
  server.listen(3000, '0.0.0.0')
  let stopping
  const stop = () => stopping ??= (async () => {
    await new Promise(resolve => server.close(resolve))
    const result = await shutdown(10000)
    if (!result.completed) process.exitCode = 1
  })()
  process.once('SIGTERM', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
  process.once('SIGINT', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
}

start().catch(error => { console.error(error); process.exitCode = 1 })
```

Run ESM and CommonJS servers with `node --import @lynktrace/node/register ...` when early instrumentation is required. For simpler deployments, the SDK's default signal handling can be used instead of the custom shutdown handlers.

### 6.7 Other Serverless Handler Shapes

There is no separate provider SDK adapter in this package. Use `wrapHandler` for an async event/context function whose returned Promise represents completion of one invocation. For HTTP request/response providers such as Vercel-style functions or Google HTTP functions, use the provider's handler contract with the Express/Fastify middleware or early Node HTTP instrumentation; do not wrap a long-lived Express/Fastify server as an event/context callback. Netlify and other event/context providers can use the AWS-style pattern only when their handler completion semantics match it. Confirm the specific provider runtime's timeout and freeze behavior in its documentation.

## 7. Zero-Code Preload & Process Bootstrap (`register.ts`)

The SDK provides `@lynktrace/node/register` as a preload entrypoint. It installs early hooks; it does not replace `init()`.

### What `register.ts` Does Internally:
1. Calls `registerEsmLoaderHooks()` to register ESM module loader hooks when supported by the Node version.
2. Calls `registerBootstrapAutoInstrumentations()` to install bootstrap instrumentation before application files import supported dependencies.
3. Does **not** read your API key or start network transport yet—it prepares the runtime so that when `await init({ apiKey })` is called, all hooks are cleanly upgraded to the live tracer.

### Auto-Instrumentation Coverage

Auto-instrumentation is remote-configured. The selectors in the SDK configuration cover these families; the application must install compatible client libraries, and ESM instrumentation requires a supported early loader hook.

| Family | Configuration selector(s) |
|---|---|
| Node HTTP / outbound requests | `http`, `https`, `fetch` (Undici), `axios` |
| Frameworks / API layers | `express`, `fastify`, `nestjs`, `graphql` |
| Databases / query layers | `prisma`, `mongodb` (also Mongoose), `redis` (also ioredis), `pg`, `mysql2`, `dynamodb`, `cassandra`, `elasticsearch`, `mssql`, `sqlite`, `typeorm`, `drizzle`, `mikroorm`, `sequelize`, `knex` |
| Queues / messaging / RPC | `bullmq`, `kafkajs`, `amqplib`, `sqs`, `sns`, `pubsub`, `grpc` |
| Other | `dns` (disabled by default), `eventEmitterPatch` |

Instrumentation availability depends on package/version and load order. Preload before app dependencies, verify that spans appear for the exact client versions you run, and avoid manually wrapping calls already instrumented. Query text and payload capture are controlled by remote privacy policy; leave parameter/message payload capture off unless needed.

---

## 8. SDK Initialization (`init`) & Complete Options Reference

### Complete `init()` Options Reference

```typescript
import { init } from '@lynktrace/node'

await init({
  // Required: API key issued by LynkTrace (or set env LYNKTRACE_API_KEY)
  apiKey: 'lynktrace_live_xxxxxxxxxxxx',

  // Optional Application Metadata (projectId, environment, and release are dynamically supplied by Remote Config):
  applicationName: 'user-service',      // Default: package.json name
  applicationVersion: '3.3.0',           // Default: package.json version

  // Lifecycle & Timeouts
  initTimeoutMs: 10000,                  // Startup request deadline in ms (default: 10000)
  initRetries: 2,                        // Max retries for transient startup failures
  shutdownTimeoutMs: 5000,               // Graceful shutdown flush deadline

  // Error Handling Behavior
  exitOnUncaughtException: true,         // SDK exits after flush only when the host has no uncaughtException handler
  crashTimeoutMs: 2000,                  // Flush timeout during fatal crash

  // Debugging & Diagnostics
  debug: false,                          // Enables verbose SDK internal logs
  logLevel: 'info',                      // 'debug' | 'info' | 'warning' | 'error' | 'fatal'

  // Persistent Offline Queue (Disk Storage)
  offlineQueue: true,                    // Set false only when losing outage-buffered events is acceptable
  // Or pass custom disk limits:
  // offlineQueue: {
  //   maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB per file
  //   maxEvents: 10000,
  //   directory: '/tmp/telemetry-events',
  // },

  // Event Filtering & Mutation Hooks
  beforeSend: (event) => {
    // Returning null drops the event. ErrorEvent has `message` at the top level.
    if (event.type === 'error' && String(event.message ?? '').includes('ETIMEDOUT')) {
      return null
    }
    return event
  },
  beforeSendTimeoutMs: 1000,             // Default: 1000ms; valid range: 1–30000ms; timeout drops this event

  beforeBreadcrumb: (breadcrumb) => {
    // Return a sanitized copy; do not mutate shared breadcrumb data.
    if (!breadcrumb.data || !('token' in breadcrumb.data)) return breadcrumb
    const { token: _token, ...safeData } = breadcrumb.data
    return { ...breadcrumb, data: safeData }
  },
})
```

### `SDKInitOptions` Reference

| Option | Type / default | Notes |
|---|---|---|
| `apiKey` | `string` (required) | If omitted, `init()` checks `LYNKTRACE_API_KEY`, then legacy `PULSE_API_KEY` / `PULSE_KEY`. Keep it in a secret store or environment. |
| `initTimeoutMs` | number; default `10000` | Startup config deadline; valid range `100`–`30000` ms. |
| `initRetries` | number; default `2` | Transient init retries; valid range `0`–`3`, within the overall init deadline. |
| `handleSignals` | boolean; default `true` | Register SDK SIGTERM/SIGINT handling. Set `false` when the application owns signal handling and calls `shutdown()`. |
| `applicationName`, `applicationVersion` | string | Optional application metadata; otherwise resolved from package metadata. |
| `packageJsonPath` | string | Explicit path used when resolving application metadata. |
| `plugins` | `SDKPlugin[]` | SDK plugins initialized after remote configuration. |
| `eventProcessors` | `EventProcessor[]` | Per-event processors; returning `null` drops the event. |
| `beforeBreadcrumb` | callback | Return a breadcrumb or `null` to filter it. Return a sanitized copy rather than mutating shared input. |
| `beforeSend` | callback | Return an event or `null`; may be async. |
| `beforeSendTimeoutMs` | number; default `1000` | Hook deadline; valid range `1`–`30000` ms. If a hook exceeds it, that event is dropped. |
| `debug` | boolean; default `false` | Enables SDK diagnostics. |
| `logLevel` | `debug \| info \| warning \| error \| fatal` | SDK logger threshold. |
| `shutdownTimeoutMs` | number; default `10000` | Default graceful shutdown deadline; valid range `1000`–`60000` ms. `shutdown(timeoutMs)` overrides it for that call. |
| `exitOnUncaughtException` | boolean | By default, SDK exits after crash flush only when it has no host-owned uncaught-exception handler. Explicit `true` forces exit; `false` leaves termination policy to the host. |
| `crashTimeoutMs` | number; default `2000` | Bounded crash flush; valid range `100`–`30000` ms. |
| `onFatalError` | `(error: Error) => void` | Optional callback before SDK-initiated fatal termination. |
| `sourceMaps` | `{ paths?, allowRemote?, embedSourceContent? }` | Local source-map lookup options; remote fetching and source-content embedding default off. |
| `offlineQueue` | boolean or `OfflineQueueInitOptions` | `false` disables disk persistence. Object fields: `enabled`, `directory`, `maxFileSizeBytes` (1 KiB–100 MiB), `maxEvents` (1–100000), `eventTtlMs` (1 min–7 days), `ioTimeoutMs` (500–60000 ms), `flushDebounceMs` (0–60000 ms). Remote config still owns the telemetry policy. |

Node's [`--import` preload flag](https://nodejs.org/api/cli.html#--importmodule), [`module.register()` version history](https://nodejs.org/api/module.html#moduleregisterspecifier-parenturl-options), and [CommonJS loading of ESM](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require) are version-sensitive; dynamic `import()` is the portable CJS pattern.

> [!NOTE]
> `init()` accepts local integration and lifecycle options. Project identity, environment, release, feature switches, sampling, privacy, limits, instrumentation and transport policy come from validated remote configuration. If initialization fails, `init()` resolves to `undefined` and the SDK enters a dormant state; check the result or `getHealth().initialized` before assuming telemetry is active. A conflicting concurrent or repeated initialization can reject with `SDKError`.

### Fail-Open Initialization & Recovery Invariants
1. `init()` performs a bounded remote configuration handshake and returns `undefined` on initialization failure; it does not invent a telemetry policy or promise active delivery without valid remote configuration.
2. Await `init()` before binding the server when startup should fail closed on missing telemetry. If the application should serve while the control plane is unavailable, bind after the bounded initialization attempt and expose SDK readiness separately.
3. Do not treat a resolved promise alone as proof of successful setup; check its return value or `getHealth().initialized`.

---

## 9. Feature Guides & Workload Profiles

### Recommended Integration by Workload

| Workload | Recommended method | Disk queue and shutdown |
|---|---|---|
| HTTP API | Preload for supported auto-instrumentation; add Express/Fastify middleware when using those frameworks. | Keep the queue enabled on writable persistent storage; close the server before `shutdown()`. |
| High-throughput service | Start with supported auto-instrumentation, low-cardinality metrics and selective profiles. Tune remote sampling/limits from observed load. | Monitor `getHealth()` queue and drop counters; don't rely on best-effort telemetry as an application queue. |
| Event/context function | Initialize during cold start and use `wrapHandler()` when the handler returns a Promise representing invocation completion. | Set `offlineQueue: false` only if disk outage buffering is unnecessary or unavailable. |
| Batch/job worker | Use `withBackgroundSpan()` per job and rethrow failures when the queue should retry them. | Stop work, close the worker, then await `shutdown()`. |
| Read-only filesystem | Configure a writable queue directory or disable persistent storage. | Disabling disk persistence trades away offline buffering; event loss during outages becomes more likely. |

### Remote Feature and Instrumentation Policy

Feature switches, sampling and instrumentation are remotely configured. The following illustrates the remote configuration shape; it is not an `init()` option and should be changed through the LynkTrace control plane:

```json
{
  "features": {
    "tracing": true,
    "errors": true,
    "requestCapture": true,
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

In AWS Lambda, Cloud Run, or environments with read-only root filesystems (`EROFS`), either mount a writable persistent directory and configure it or pass `offlineQueue: false`. Disabling the queue removes disk outage buffering, so use it only when that loss tradeoff is acceptable:

```typescript
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  offlineQueue: false, // Disables persistent disk buffering
})
```

### Emergency Operational Killswitches

Remote killswitches can disable telemetry when the updated configuration reaches the SDK:
- `killswitches.disableTransport: true` (Drops all outgoing HTTP transport)
- `killswitches.disableProfiling: true` (Stops all V8 CPU & Heap samplers)
- `killswitches.disableTracing: true` (Turns off span generation)
- `killswitches.disableErrors: true` (Silences exception capture)

---

## 10. Core Features & Capabilities

CommonJS examples in this section are call-site snippets inside an async function; `.cjs` files cannot use top-level `await`. Load the SDK with dynamic `import()` as shown, and run `init()` once during startup.

### A. Error Tracking & Exception Capture

**Recommended:** let framework/process instrumentation capture unhandled failures. Use `captureException()` for handled failures that your code consumes, and scope user/context data with `withScope()` or the active request context. Do not put secrets, credentials, full request bodies, or payment data in tags/extras.

```typescript
import { captureException, setExtra, setTag, setUser, withScope } from '@lynktrace/node'

await withScope(async () => {
  setUser({ id: 'user_9921' })
  setTag('customer_tier', 'enterprise')
  setExtra('operation', 'checkout')
  try {
    await submitCheckout()
  } catch (error) {
    captureException(error, { severity: 'error', mechanism: 'checkout', handled: true })
  }
})
```

CommonJS call site (inside your async startup/request function):

```javascript
const { captureException, setExtra, setTag, setUser, withScope } = await import('@lynktrace/node')
await withScope(async () => {
  setUser({ id: 'user_9921' })
  setTag('customer_tier', 'enterprise')
  setExtra('operation', 'checkout')
  try { await submitCheckout() }
  catch (error) { captureException(error, { severity: 'error', mechanism: 'checkout', handled: true }) }
})
```

### B. Distributed Tracing & W3C Context Propagation

**Recommended:** use early auto-instrumentation for supported HTTP clients, database drivers and messaging libraries. Use the propagation helpers only at custom boundaries that are not instrumented. Trace and span IDs can be `undefined` outside an active span.

```typescript
import { getTraceId, getSpanId, injectTraceContext } from '@lynktrace/node'

const traceId = getTraceId()
const spanId = getSpanId()
const headers: Record<string, string> = {}
injectTraceContext(headers) // Use only for custom, non-instrumented transports.
console.log(`Current Trace ID: ${traceId}, Span ID: ${spanId}`)
```

```javascript
const { getTraceId, getSpanId, injectTraceContext } = await import('@lynktrace/node')
const traceId = getTraceId()
const headers = {}
injectTraceContext(headers) // Use for a custom, non-instrumented outbound transport.
console.log({ traceId, spanId: getSpanId() })
```

### C. Custom Spans & Database Query Attribution

**Recommended:** prefer the supported auto-instrumentation for database clients. Add a manual span around meaningful application work or unsupported clients; omit query parameters and secrets from attributes.

```typescript
import { withSpan, withDbSpan } from '@lynktrace/node'

// Custom application span
const result = await withSpan('calculateMonthlyInvoice', async (span) => {
  span.setAttribute('invoice.customer_id', 'cust_42')
  return computeInvoice()
})

// Database query span with truthful exclusive timing attribution
const rows = await withDbSpan({
  system: 'postgresql',
  statement: 'SELECT * FROM users WHERE active = $1', // Keep values out of statement text.
  operation: 'SELECT',
  table: 'users',
}, async () => {
  return pgPool.query('SELECT * FROM users WHERE active = $1', [true])
})
```

CommonJS:

```javascript
const { withSpan, withDbSpan } = await import('@lynktrace/node')
const result = await withSpan('calculateMonthlyInvoice', async span => {
  span.setAttribute('invoice.customer_id', 'cust_42')
  return computeInvoice()
})
const rows = await withDbSpan({ system: 'postgresql', operation: 'SELECT', table: 'users' }, () => pool.query('SELECT * FROM users WHERE active = $1', [true]))
```

### D. Detached Background Task Tracing (`withBackgroundSpan`)

When a background task outlives the request that scheduled it, use `withBackgroundSpan` to create an independent trace. Await it when possible; if it must be detached, attach a rejection handler and ensure the worker has a shutdown drain.

```typescript
import { withBackgroundSpan } from '@lynktrace/node'

await withBackgroundSpan('generatePdfReport', async (span) => {
  span.setAttribute('report.format', 'pdf')
  await renderPdf()
})
```

CommonJS:

```javascript
const { withBackgroundSpan } = await import('@lynktrace/node')
await withBackgroundSpan('generatePdfReport', async span => {
  span.setAttribute('report.format', 'pdf')
  await renderPdf()
})
```

### E. OpenTelemetry Metrics & Exponential Histograms

**Recommended:** use `incrementCounter`, `setGauge` and `recordHistogram`; choose stable metric names and low-cardinality tags. Never use user IDs, request IDs, email addresses or arbitrary URLs as metric labels.

```typescript
import { incrementCounter, recordHistogram, setGauge } from '@lynktrace/node'

// Increment a counter (default increment is 1)
incrementCounter('api.requests.total', 1, { route: '/checkout', status: '200' }, 'request')

// Record a latency sample
recordHistogram('api.checkout.duration', 142.5, { route: '/checkout' }, 'ms')

// Update a gauge
setGauge('queue.pending_jobs', 18, { queue_name: 'high-priority' })
```

CommonJS:

```javascript
const { incrementCounter, recordHistogram, setGauge } = await import('@lynktrace/node')
incrementCounter('api.requests.total', 1, { route: '/checkout', status: '200' }, 'request')
recordHistogram('api.checkout.duration', 142.5, { route: '/checkout' }, 'ms')
setGauge('queue.pending_jobs', 18, { queue_name: 'high-priority' })
```

### F. V8 CPU & Heap Profiling with Duty-Cycle Cooling

**Recommended:** rely on remote profiling policy for continuous profiling. Use manual profiles only for a bounded diagnostic window, and stop them in `finally`. These calls may return `false` or no-op when profiling is not entitled or initialized.

```typescript
import { startProfile, stopProfile, startHeapProfile, stopHeapProfile } from '@lynktrace/node'

if (await startProfile('checkout-spike')) {
  try { await reproduceCheckoutLoad() }
  finally { await stopProfile('checkout-spike') }
}

if (await startHeapProfile('memory-audit')) {
  try { await runMemoryDiagnostic() }
  finally { await stopHeapProfile('memory-audit') }
}
```

CommonJS:

```javascript
const { startProfile, stopProfile, startHeapProfile, stopHeapProfile } = await import('@lynktrace/node')
if (await startProfile('checkout-spike')) {
  try { await reproduceCheckoutLoad() }
  finally { await stopProfile('checkout-spike') }
}
if (await startHeapProfile('memory-audit')) {
  try { await runMemoryDiagnostic() }
  finally { await stopHeapProfile('memory-audit') }
}
```

#### Continuous CPU Profiling with Duty-Cycle Cooling
Continuous profiling is a remote-config setting. Coordinate sampling rate and duty cycle with your telemetry administrator and observe application overhead before enabling it broadly:

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

**Recommended:** enable only the remote runtime metrics you need. Use `getHealth()` to inspect the SDK's own queue, pressure, circuit, quota, persistence and metric state; it is an SDK health snapshot, not a replacement for host or container monitoring.

ESM:

```typescript
import { getHealth } from '@lynktrace/node'

const health = getHealth()
console.log({ initialized: health.initialized, queueSize: health.queueSize, pressure: health.pressure.level })
```

CommonJS:

```javascript
const { getHealth } = await import('@lynktrace/node')
const health = getHealth()
console.log({ initialized: health.initialized, queueSize: health.queueSize, pressure: health.pressure.level })
```

The runtime metrics, GC and event-loop monitors are controlled by remote configuration and may depend on host/runtime support. They are telemetry, not a substitute for external health checks or resource limits.

#### 1. CPU Load & Throttling Monitor
Tracks core counts, load averages (1m, 5m, 15m), user/system CPU execution ticks, and detects hypervisor CPU quota throttling (e.g., in Docker, Kubernetes, or AWS ECS burstable instances).

#### 2. GPU Detector
GPU detection is best-effort and host-dependent. Do not assume GPU metrics are available on every operating system or container.

#### 3. Storage & Disk Capacity Detector
Storage inspection is best-effort and host-dependent. Check the `StorageDetector` API and platform permissions before relying on any particular mount or filesystem metric.

#### 4. V8 Garbage Collection (GC) Monitor
Hooks into V8 performance observers to record Garbage Collection events:
- **Scavenge**: Minor young generation GC pauses
- **Mark-Sweep-Compact**: Major full heap collection pauses
- **Incremental & Weak Processing**: Background GC passes
- Reclaimed memory bytes and GC pressure index.

#### 5. Event Loop Delay & Lag Monitor
Uses `perf_hooks.monitorEventLoopDelay()` to calculate real-time p50, p90, p95, p99, and maximum event loop lag.

#### 6. Process and Container Memory Pressure
Memory and adaptive-pressure snapshots are exposed through `getHealth()`. Thresholds and shedding policy are runtime configuration; do not depend on fixed score cutoffs as a public configuration contract.

### H. Enterprise Structured Logging & Integrations

**Recommended:** connect one logging path (`captureLog`, Winston, or Pino) and retain your normal local log output. Send only fields safe for your telemetry destination. Console interception is a remote-config feature; no local `init()` switch enables it.

#### 1. Public `captureLog()` API
Capture structured logs with severity levels (`trace`, `debug`, `info`, `warn`/`warning`, `error`, `fatal`) and structured arguments:

```typescript
import { captureLog, addBreadcrumb } from '@lynktrace/node'

// Automatic breadcrumb bridging + distributed trace correlation
captureLog('info', 'User authenticated via OAuth2', { userId: 'usr_9812', provider: 'github' })
captureLog('warn', 'Payment gateway high latency', { gateway: 'stripe', latencyMs: 3420 })
captureLog('error', 'Database connection refused', { host: 'db.prod.internal', port: 5432 })
```

CommonJS:

```javascript
const { captureLog } = await import('@lynktrace/node')
captureLog('info', 'User authenticated', { userId: 'usr_9812', provider: 'github' })
```

#### 2. Automatic Console Interception
When remote `logs.captureConsole` is enabled, supported `console.*` calls are captured as log events. Console calls continue to write through to the original console methods. Avoid enabling both console capture and a logger bridge for the same messages unless duplicate telemetry is intended.

#### 3. Winston Integration
Use `createWinstonTransport` to stream Winston logs directly into telemetry with automatic OpenTelemetry trace correlation:

```typescript
import winston from 'winston'
import { createWinstonTransport } from '@lynktrace/node'

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console(),
    createWinstonTransport({ level: 'info' }), // Automatically bridges logs + trace context
  ],
})

logger.info('Order placed', { orderId: 'ord_123', total: 99.50 })
```

CommonJS (install `winston` as an application dependency):

```javascript
const winston = require('winston')
const { createWinstonTransport } = await import('@lynktrace/node')
const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console(), createWinstonTransport({ level: 'info' })],
})
logger.info('Order placed', { orderId: 'ord_123' })
```

#### 4. Pino Integration
Use `createPinoStream` and `pinoTraceMixin` for high-throughput zero-overhead Pino logging with automatic distributed trace injection:

```typescript
import pino from 'pino'
import { createPinoStream, pinoTraceMixin } from '@lynktrace/node'

const logger = pino(
  {
    mixin: pinoTraceMixin, // Automatically injects trace_id and span_id into every log
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: createPinoStream() }, // Streams NDJSON logs to telemetry non-blockingly
  ])
)
```

CommonJS (install `pino` as an application dependency):

```javascript
const pino = require('pino')
const { createPinoStream, pinoTraceMixin } = await import('@lynktrace/node')
const logger = pino({ mixin: pinoTraceMixin }, pino.multistream([
  { stream: process.stdout },
  { stream: createPinoStream() },
]))
logger.info({ orderId: 'ord_123' }, 'Order placed')
```

#### 5. Diagnostic Log Controls & SRE Runtime Auditing
```typescript
import {
  setLogLevel,
  setLogFormat,
  getLoggerWriterStats,
  LoggingSubsystem,
} from '@lynktrace/node'

// Switch format to OpenTelemetry/ECS-compliant NDJSON in production containers
setLogFormat('json') // 'text' | 'json'
setLogLevel('info')  // 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'

// SRE Runtime Health Auditing
const { stdoutDrops, stderrDrops } = getLoggerWriterStats()
const subsystem = LoggingSubsystem.getInstance()
const rateLimitDrops = subsystem?.getRateLimitDrops() ?? 0
console.log({ stdoutDrops, stderrDrops, rateLimitDrops })
```

CommonJS:

```javascript
const { setLogLevel, setLogFormat, getLoggerWriterStats } = await import('@lynktrace/node')
setLogFormat('json')
setLogLevel('info')
console.log(getLoggerWriterStats())
```

### I. Cron & Scheduled Job Heartbeats (`captureCronCheckIn`)

**Recommended:** emit `in_progress` and one terminal `ok` or `error` for each run. Use a stable monitor slug and a duration; the API is gated by remote entitlement/configuration.

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
  throw error
}
```

CommonJS:

```javascript
const { captureCronCheckIn } = await import('@lynktrace/node')
const started = Date.now()
captureCronCheckIn('nightly-database-backup', 'in_progress')
try {
  await performBackup()
  captureCronCheckIn('nightly-database-backup', 'ok', { duration: Date.now() - started })
} catch (error) {
  captureCronCheckIn('nightly-database-backup', 'error', { duration: Date.now() - started })
  throw error
}
```

### J. Custom Business Event Ingestion

**Recommended:** use a stable event type and include only business attributes needed for analysis. `captureEvent()` returns an `EventReceipt`; check `accepted` when the caller must know whether the local pipeline admitted the event. Admission is not confirmation of backend delivery.

```typescript
import { captureEvent } from '@lynktrace/node'

const receipt = captureEvent({
  type: 'order_completed',
  orderId: 'ord-8831',
  amount: 249.99,
  currency: 'USD',
  timestamp: Date.now(),
})
if (!receipt.accepted) console.warn('Order event was not admitted:', receipt.reason)
```

CommonJS:

```javascript
const { captureEvent } = await import('@lynktrace/node')
const receipt = captureEvent({ type: 'order_completed', orderId: 'ord-8831', amount: 249.99, currency: 'USD' })
if (!receipt.accepted) console.warn('Order event was not admitted:', receipt.reason)
```

---

## 11. Transport Pipeline & Delivery Behavior

### Per-Route Queue Isolation
Events are routed to per-route queues and batch managers to reduce head-of-line blocking between event classes:
- `errors` (`/v1/errors`)
- `traces` (`/v1/traces`)
- `spans` (`/v1/spans`)
- `requests` (`/v1/requests`)
- `metrics` (`/v1/metrics`)
- `logs` (`/v1/logs`)
- `profiles` (`/v1/profiles`)
- `crons` (`/v1/crons`)
- `events` (`/v1/events`)

Queue separation does not guarantee delivery or prevent all delay and drops. Sampling, entitlements, quotas, queue pressure, shutdown deadlines, network failures and server responses can reject or defer events. Use `captureEvent()`'s receipt for local admission and `getHealth()` for SDK queue/transport state; neither proves backend persistence.

### Worker Thread Serialization & Event Loop Protection
The worker serialization pool can offload payload serialization according to remote `transport.workerOffloadThresholdBytes` policy. If serialization or worker processing fails, payload handling may fail or events may be dropped; do not depend on an exact threshold or a zero-overhead guarantee.

### Bounded Retry Bookkeeping
Retry attempts are bounded by the configured transport policy and an internal maximum retention age. Exhausted, stale, or evicted work may be discarded; retries are not an exactly-once delivery protocol.

### Circuit Breakers & Backoff
Per-route circuit breakers and backoff reduce repeated work during service/network failures. Retry timing and eligibility are implementation/configuration details; application code should not assume exactly-once delivery.

### Offline Disk Spooling & Deduplication
- When enabled and the configured filesystem is writable, undelivered events can be spooled to bounded NDJSON files and replayed on a later initialization.
- Replay requests include `X-LynkTrace-Replay: true`. Backend deduplication depends on backend support and `eventId`; the SDK cannot promise exactly-once delivery across process crashes or ambiguous network responses.

---

## 12. Privacy, PII Scrubbing & Security

The SDK applies configurable privacy capture policy and scrubbing. Treat this as defense in depth, not as a guarantee that arbitrary secrets are detected:
- **Luhn Mod-10 Algorithm**: Automatically redacts Visa, Mastercard, American Express, and Discover PAN numbers.
- **Secrets & Credentials**: Automatically masks Social Security Numbers (SSN), AWS Access Keys, Stripe Secret Keys, JWT tokens, and Bearer authorization headers.
- **Bounded nested scrubbing**: Object/array scrubbing uses configurable `privacy.scrubbing.maxDepth` (default: 10).
- **Bounded string processing**: Text scanning is capped at 8 KiB per string; longer strings are truncated and end with `[truncated]`.
- Prefer disabling capture of request bodies, cookies, authorization headers, and query parameters unless they are needed. Never pass credentials or raw secrets in custom attributes, log fields, or exception messages.

---

## 13. Complete API Reference

### Core lifecycle, capture and health

| Named exports | Purpose and key contract |
|---|---|
| `init(options)` | Initializes from remote configuration; resolves to the validated config or `undefined` if initialization fails. Conflicting concurrent initialization may reject. |
| `flush()` | Best-effort flush of in-memory pipelines and persistence. It takes no timeout parameter. |
| `shutdown(timeoutMs?)` | Drains and tears down SDK resources; returns `ShutdownResult` with timeout, remaining-event and step-error details. |
| `emergencyFlush(timeoutMs?)` | Bounded best-effort crash-path drain; does not perform normal subsystem teardown. |
| `getHealth()` | Returns SDK queue, pressure, quota, transport, persistence, session and metric state. It does not confirm backend receipt. |
| `getConfig()` | Returns the active immutable remote configuration; call after successful initialization. |
| `captureException(error, severityOrOptions?)` | Captures an exception; optional severity is a severity string or `{ severity, mechanism, handled }`. Returns `void`. |
| `captureMessage(message, severity?, context?)` | Captures a message event. Returns `void`. |
| `captureRequest(event)` | Submits a canonical request event. Prefer framework integrations for automatic request capture. |
| `captureEvent(event)` | Submits a canonical or custom event and returns `EventReceipt` with local admission status and `processed` promise. |
| `captureLog(level, message, ...args)` | Captures a structured log event. |
| `captureCronCheckIn(slug, status, options?)` | Captures `in_progress`, `ok` or `error`; options include `duration` and `environment`. |
| `captureMetric(name, value, type?, options?)` | Records a counter, gauge or histogram; options are `{ tags, unit }`. |
| `incrementCounter`, `setGauge`, `recordHistogram`, `addUpDownCounter` | Convenience metric methods accepting `(name, value, tags?, unit?)`. |
| `startProfile(id)`, `stopProfile(id)` | Start and stop a manual CPU profile. `startProfile` returns `Promise<boolean>`. |
| `startHeapProfile(id)`, `stopHeapProfile(id)` | Start and stop a manual heap profile. `startHeapProfile` returns `Promise<boolean>`. |
| `wrapHandler(handler, options?)` | Wraps a Promise/event-context or callback-style serverless handler and races flush against `flushTimeoutMs`; it is not a delivery guarantee. |
| `SDKError`, `SDK_NAME`, `SDK_VERSION`, `BACKEND_BASE_URL` | Public error class and SDK/backend constants. |

### Context, scope and tracing

| Named exports | Purpose |
|---|---|
| `addBreadcrumb`, `getRequestContext`, `getTraceId`, `getSpanId` | Add breadcrumbs or read the active request/trace context. Trace IDs can be absent outside an active trace. |
| `withContext`, `createContextStore`, `bindContext` | Advanced AsyncLocalStorage context helpers. |
| `setUser`, `setTag`, `setTags`, `removeTag`, `setExtra`, `setExtras`, `removeExtra`, `setContext`, `getScopeData`, `clearScope`, `withScope` | Scope data API. Use `withScope()` for temporary per-operation identity/metadata. |
| `startSpan`, `withSpan`, `withSpanSync`, `trace`, `wrap` | Manual spans and function wrappers. |
| `withBackgroundSpan`, `startBackgroundSpan`, `getActiveBackgroundSpanCount` | Independent background traces and their active count. |
| `getActiveSpan`, `flushTracer`, `startDbSpan`, `withDbSpan`, `withDbSpanSync` | Advanced active-span, tracer and database-span APIs. |
| `extractTraceContext`, `injectTraceContext` | Extract/inject W3C trace context at custom, non-instrumented boundaries. |
| `LynkTraceSpan`, `computeExclusiveDuration`, `SpanDurationTracker`, `spanDurationTracker` | Span class and timing helpers. |

### Framework and instrumentation exports

| Named exports | Intended use |
|---|---|
| `lynktraceMiddleware`, `expressErrorHandler`, `lynktraceExpressErrorHandler`, `instrumentExpress` | Express request middleware, error middleware and optional middleware-layer instrumentation. |
| `lynktraceFastifyPlugin` | Fastify hooks for request context, capture and expected-response filtering. |
| `registerAutoInstrumentations`, `registerEsmLoaderHooks` | Advanced registration controls; normally use the `@lynktrace/node/register` preload. |
| `createGraphQLInstrumentation` | Manual OpenTelemetry GraphQL instrumentation factory. |
| `createPrismaInstrumentation`, `lynktracePrismaExtension`, `instrumentPrismaClientInstance` | Prisma instrumentation options and client integration. |
| `createMongoDBInstrumentation`, `createMongooseInstrumentation`, `MongooseInstrumentation`, `LynkTraceMongooseInstrumentation` | MongoDB/Mongoose instrumentation. |
| `createRedisInstrumentation`, `createBullMQInstrumentation`, `createAxiosInstrumentation`, `createPgInstrumentation`, `patchPgPoolConnectOnce`, `createMySQLInstrumentation` | Instrumentation factories for the named clients and queue. |
| `LynkTraceDrizzleLogger`, `createDrizzleInstrumentation` | Drizzle integration. |
| `patchEventEmitter`, `unpatchEventEmitter`, `installHttpLifecycleGuard`, `uninstallHttpLifecycleGuard`, `isOtelInstrumentationError` | Advanced process-level instrumentation controls; use only when you own instrumentation lifecycle. |

### Logging, monitors and utility exports

`setLogger`, `getLogger`, `setDebugMode`, `isDebugMode`, `setLogLevel`, `getLogLevel`, `setLogFormat`, `getLogFormat`, `setLogPrefix`, `getLogPrefix`, and `getLoggerWriterStats` configure/read the SDK logger. `createWinstonTransport`, `LynkTraceWinstonTransport`, `createPinoStream`, `LynkTracePinoStream`, and `pinoTraceMixin` connect Winston/Pino. `LoggingSubsystem` and `LogRateLimiter` are exported for advanced integrations; prefer `captureLog()` for application code.

`cpuMonitor`, `gpuMonitor`, and `StorageDetector` expose host monitor helpers. `generateId`, `generateShortId`, `isValidUUID`, `isValidUUIDv7`, and `extractTimestampFromUUIDv7` expose ID helpers. `Severity`, `severityFromString`, `isSeverityGte`, `doesSeverityMeetThreshold`, and `classifyError` expose runtime severity/error helpers.

### Public types

The root entrypoint exports `SDKInitOptions`, `RemoteConfigResponse`, `EntitlementsConfig`, `OfflineQueueConfig`, `OfflineQueueInitOptions`; event types `SDKEvent`, `RequestEvent`, `ErrorEvent`, `MessageEvent`, `MetricEvent`, `EventMetadata`, `StackFrame`, `LogEvent`, `ProfileEvent`, `CronCheckInEvent`, `SpanEvent`, `TraceEvent`, `AggregatedSpanEvent`; `Breadcrumb`, `BreadcrumbInput`, `BreadcrumbHint`; `SeverityLevel`; `SDKPlugin`, `PluginMeta`, `PluginContext`, `EventProcessor`, `BreadcrumbProcessor`; `ErrorSeverity`, `ErrorMechanism`, `ErrorClassification`, `ParsedError`, `ErrorGrouping`; `EventReceipt`, `ContextStore`, `User`, `ScopeData`; `ServerlessHandler`, `ServerlessHandlerOptions`, `CronCheckInOptions`, `CaptureLogLevel`; `DbSpanOptions`, `DbSystem`, `SpanStatus`, `SpanKindName`, `SpanOptions`, `SpanLink`, `BackgroundSpanOptions`; `LynkTraceExpressOptions`, `LynkTraceFastifyOptions`; `GraphQLInstrumentationOptions`, `PrismaInstrumentationOptions`, `MongoDBInstrumentationOptions`, `MongooseInstrumentationOptions`, `RedisInstrumentationOptions`, `BullMQInstrumentationOptions`, `AxiosInstrumentationOptions`, `PgInstrumentationOptions`, `MySQLInstrumentationOptions`, `DrizzleInstrumentationOptions`; `SpanInterval`, `DurationBreakdown`; `Logger`, `LogFormat`, `LynkTraceWinstonOptions`, `LynkTracePinoOptions`; and telemetry types `TelemetryPriority`, `PressureState`, `QuotaState`, `DegradationInfo`, `CorrelationGroupInfo`, `OperationalMetricsSnapshot`.

`LynkTrace` and the default export are a convenience facade containing common lifecycle, capture, tracing, context and framework methods. They are not a substitute for the complete named export surface listed above. `@lynktrace/node/internals` is explicitly unstable and must not be used as a production integration contract.

The facade includes `init`, `flush`, `shutdown`, `emergencyFlush`, `wrapHandler`, common capture/metric methods, manual profile methods, `addBreadcrumb`, common scope setters, span/database tracing methods, trace/span ID getters, `getHealth`, and Express/Fastify integration methods. Import uncommon helpers and instrumentation factories by their named root export.

---

## 14. Graceful Shutdown & Kubernetes Lifecycle

By default, `init()` registers SIGTERM/SIGINT handlers that call the SDK shutdown flow. If the application already owns signal handling, set `handleSignals: false`, stop accepting application work, await `shutdown()`, inspect its result and let Node exit naturally. Do not call `process.exit()` immediately after `flush()`; it can truncate application and SDK cleanup.

```typescript
import { createServer } from 'node:http'
import { init, shutdown } from '@lynktrace/node'

await init({ apiKey: process.env.LYNKTRACE_API_KEY!, handleSignals: false })
const server = createServer((_req, res) => res.end('ok'))
server.listen(3000, '0.0.0.0')

let stopPromise: Promise<void> | undefined
const stop = () => stopPromise ??= (async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const result = await shutdown(10000)
  if (!result.completed) process.exitCode = 1
})()
process.once('SIGTERM', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
process.once('SIGINT', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
```

CommonJS (`server.cjs`):

```javascript
const { createServer } = require('node:http')

async function start() {
  const { init, shutdown } = await import('@lynktrace/node')
  await init({ apiKey: process.env.LYNKTRACE_API_KEY, handleSignals: false })
  const server = createServer((_req, res) => res.end('ok'))
  server.listen(3000, '0.0.0.0')
  let stopPromise
  const stop = () => stopPromise ??= (async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const result = await shutdown(10000)
    if (!result.completed) process.exitCode = 1
  })()
  process.once('SIGTERM', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
  process.once('SIGINT', () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) })
}

start().catch(error => { console.error(error); process.exitCode = 1 })
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
