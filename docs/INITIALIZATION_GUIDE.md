# Pulse APM Node.js SDK — The Complete Initialization & Load-Order Guide

This guide is the definitive reference on **where**, **when**, and **in which format** to call `init()` so that `@pulse-apm/node` correctly captures traces, database queries, unhandled exceptions, and request metrics across every Node.js architecture.

---

## Table of Contents

1. [The Golden Rule: Why Load-Order Dictates 100% of APM Success](#the-golden-rule)
2. [The 3 Ironclad Rules of Initialization](#the-3-ironclad-rules-of-initialization)
3. [Format Decision Matrix: Which Pattern Do You Need?](#format-decision-matrix)
4. [Case-by-Case Implementation Recipes](#case-by-case-implementation-recipes)
   - [Case 1: Native ESM with Static Imports (Recommended: `--import`)](#case-1-native-esm-with-static-imports)
   - [Case 2: Native ESM with Top-Level Await & Dynamic Imports](#case-2-native-esm-with-top-level-await--dynamic-imports)
   - [Case 3: CommonJS (`require`)](#case-3-commonjs-require)
   - [Case 4: TypeScript Projects (`tsc`, `ts-node`, `tsx`)](#case-4-typescript-projects)
   - [Case 5: Express.js Applications](#case-5-expressjs-applications)
   - [Case 6: Fastify Applications](#case-6-fastify-applications)
   - [Case 7: NestJS Applications](#case-7-nestjs-applications)
   - [Case 8: Background Workers, Queues (BullMQ) & Cron Jobs](#case-8-background-workers-queues--cron-jobs)
   - [Case 9: Docker & Containerized Microservices](#case-9-docker--containerized-microservices)
5. [What `init()` Actually Needs (Configuration Simplicity)](#what-init-actually-needs)
6. [Fatal Anti-Patterns: What NEVER To Do](#fatal-anti-patterns)
7. [How to Verify Initialization Succeeded](#how-to-verify-initialization-succeeded)

---

## The Golden Rule

> **Auto-instrumentation works by monkey-patching core modules (`http`, `https`) and third-party drivers (`pg`, `mysql2`, `redis`, `ioredis`, `mongodb`, `undici`, `axios`) when they are loaded into memory.**
>
> If a database client or HTTP framework is loaded **before** `@pulse-apm/node` can install its interception hooks, those libraries will hold references to the original unpatched Node.js functions. Their queries and requests will **NOT** be traced.

Therefore:
1. `@pulse-apm/node` must be **imported first**.
2. `await init({ apiKey })` must be **awaited before** database pools connect or the server listens for traffic.

---

## The 3 Ironclad Rules of Initialization

| Rule | Requirement | Rationale |
| :--- | :--- | :--- |
| **Rule 1: Line 1 of Entrypoint** | Put the Pulse SDK import on line 1 of your main process entry file (`index.ts`, `server.js`, `main.ts`). | Installs synchronous bootstrap hooks before anything else evaluates. |
| **Rule 2: Await `init()` Early** | `await init({ apiKey })` must resolve before creating database connection pools (`new Pool()`) and before calling `app.listen()`. | Ensures remote sampling rates, privacy scrubbing, and trace providers are authoritative. |
| **Rule 3: Process Singleton** | Call `init()` **once and only once** per Node.js process. Never call `init()` inside route handlers, request listeners, or helper functions. | OpenTelemetry and `AsyncLocalStorage` are process-level singletons. Re-initializing throws `SDK_ALREADY_INITIALIZED`. |

---

## Format Decision Matrix

Use this cheat sheet to pick the exact pattern for your project:

```
Is your project ESM ("type": "module" in package.json)?
│
├── YES ──► Do you use standard static `import ... from 'pg'`?
│           │
│           ├── YES ──► Use Case 1 (node --import @pulse-apm/node/register server.js) [RECOMMENDED]
│           └── NO  ──► Use Case 2 (await init(), then await import('./app.js'))
│
└── NO  ──► Are you using CommonJS (`require`)?
            │
            └── YES ──► Use Case 3 (require at top, await init() in bootstrap())
```

---

## Case-by-Case Implementation Recipes

### Case 1: Native ESM with Static Imports (Recommended: `--import`)

In ECMAScript Modules (ESM), Node.js evaluates all top-level static `import` declarations **before** executing the first line of code in the module.

To ensure database drivers like `pg`, `mysql2`, and `redis` are intercepted even when imported via static `import`, launch Node.js with the `--import` preload flag:

#### Startup Command / `package.json`
```json
{
  "name": "my-service",
  "type": "module",
  "scripts": {
    "start": "node --import @pulse-apm/node/register server.js"
  }
}
```

#### `server.js` (Application Code)
```javascript
import { init, monitorMiddleware, expressErrorHandler } from '@pulse-apm/node'
import express from 'express'
import pg from 'pg'

// 1. Initialize the SDK at startup (reads package.json for application name & version)
await init({
  apiKey: process.env.PULSE_API_KEY || 'pk_live_your_api_key_here',
})

// 2. Setup your server and database connection pools
const app = express()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

app.use(express.json())
app.use(monitorMiddleware())

app.get('/api/users', async (req, res) => {
  // Traced automatically as a child span of this HTTP request!
  const { rows } = await pool.query('SELECT id, name FROM users')
  res.json({ users: rows })
})

app.use(expressErrorHandler())
app.listen(3000, () => console.log('Server running on :3000'))
```

---

### Case 2: Native ESM with Top-Level Await & Dynamic Imports

If you cannot or do not want to pass the `--import` CLI flag, you can split your startup into an entrypoint loader using dynamic `import()`:

#### `index.js` (Root Process Entrypoint)
```javascript
import { init } from '@pulse-apm/node'

// 1. Initialize SDK before anything else is loaded
await init({
  apiKey: process.env.PULSE_API_KEY!,
})

// 2. Dynamically import your application code AFTER init completes
await import('./server.js')
```

#### `server.js` (Main Application Logic)
```javascript
import express from 'express'
import pg from 'pg'
import { monitorMiddleware, expressErrorHandler } from '@pulse-apm/node'

const app = express()
const pool = new pg.Pool()

app.use(monitorMiddleware())
// ... define routes
app.use(expressErrorHandler())
app.listen(3000)
```

---

### Case 3: CommonJS (`require`)

In CommonJS, `require()` is synchronous and executes strictly in sequential order.

#### `server.js`
```javascript
// 1. Require the SDK first
const { init, monitorMiddleware, expressErrorHandler } = require('@pulse-apm/node')

async function bootstrap() {
  // 2. Initialize the SDK
  await init({
    apiKey: process.env.PULSE_API_KEY || 'pk_live_your_api_key_here',
  })

  // 3. Require frameworks and drivers AFTER init() resolves
  const express = require('express')
  const { Pool } = require('pg')

  const app = express()
  const pool = new Pool()

  app.use(express.json())
  app.use(monitorMiddleware())

  app.get('/api/orders', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM orders LIMIT 50')
    res.json(rows)
  })

  app.use(expressErrorHandler())
  app.listen(3000, () => console.log('Server running on port 3000'))
}

bootstrap().catch(console.error)
```

---

### Case 4: TypeScript Projects (`tsc`, `ts-node`, `tsx`)

TypeScript compilers sometimes hoist or reorder `import` statements during output emission. Use `--import` or `NODE_OPTIONS` to guarantee 100% reliable patching.

#### Using `tsx` (Modern Fast TS Runner)
```bash
# Set NODE_OPTIONS or pass --import directly:
node --import @pulse-apm/node/register --loader tsx src/server.ts
# Or with tsx CLI:
NODE_OPTIONS="--import @pulse-apm/node/register" tsx src/server.ts
```

#### Compiled TypeScript (`tsc` -> `dist/`)
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node --import @pulse-apm/node/register dist/server.js"
  }
}
```

---

### Case 5: Express.js Applications

The exact execution order in an Express application must be:

```typescript
import { init, monitorMiddleware, expressErrorHandler } from '@pulse-apm/node'
import express from 'express'
import pg from 'pg'

// 1. Initialize SDK
await init({ apiKey: process.env.PULSE_API_KEY! })

// 2. Construct app
const app = express()

// 3. Body parsers (must precede monitorMiddleware to capture request bodies)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 4. Mount monitorMiddleware FIRST among custom middleware
//    (binds AsyncLocalStorage context & starts HTTP server span)
app.use(monitorMiddleware({
  ignorePaths: ['/healthz', '/ready'],
}))

// 5. App routes
app.get('/api/pay', async (req, res) => {
  // DB queries here automatically attach to the active request trace
  res.json({ success: true })
})

// 6. Mount expressErrorHandler LAST after all routes
//    (correlates unhandled exceptions to the active trace and marks span as ERROR)
app.use(expressErrorHandler())

// 7. Start server
app.listen(3000)
```

---

### Case 6: Fastify Applications

Fastify uses an encapsulated plugin lifecycle. Use `fastifyPulsePlugin`:

```typescript
import { init, fastifyPulsePlugin } from '@pulse-apm/node'
import Fastify from 'fastify'

// 1. Initialize SDK
await init({ apiKey: process.env.PULSE_API_KEY! })

// 2. Create Fastify instance
const fastify = Fastify({ logger: true })

// 3. Register Pulse plugin
await fastify.register(fastifyPulsePlugin)

// 4. Routes
fastify.get('/api/items', async (request, reply) => {
  return { items: [] }
})

// 5. Start listening
await fastify.listen({ port: 3000, host: '0.0.0.0' })
```

---

### Case 7: NestJS Applications

In NestJS, place `init()` at the very top of `src/main.ts` before `NestFactory.create()`:

#### `src/main.ts`
```typescript
import { init } from '@pulse-apm/node'

async function bootstrap() {
  // 1. Initialize Pulse APM BEFORE NestFactory constructs the dependency injection tree
  await init({
    apiKey: process.env.PULSE_API_KEY || 'pk_live_your_api_key_here',
  })

  // 2. Import and bootstrap AppModule
  const { NestFactory } = await import('@nestjs/core')
  const { AppModule } = await import('./app.module.js')

  const app = await NestFactory.create(AppModule)
  await app.listen(3000)
}

bootstrap().catch(console.error)
```

---

### Case 8: Background Workers, Queues (BullMQ) & Cron Jobs

When running background tasks, queue workers, or cron processes:

1. Call `await init({ apiKey })` when the worker process boots up.
2. If work continues after an HTTP response or in a worker thread, wrap it in **`withBackgroundSpan()`** so its traces are detached from HTTP deadlines and never dropped:

```typescript
import { init, withBackgroundSpan, withDbSpan } from '@pulse-apm/node'
import { Worker } from 'bullmq'

await init({ apiKey: process.env.PULSE_API_KEY! })

const worker = new Worker('email-queue', async (job) => {
  // Wrap background work in withBackgroundSpan
  return await withBackgroundSpan(`job.${job.name}`, async (span) => {
    span.setAttribute('job.id', job.id!)

    // Perform database operations inside background trace
    await withDbSpan({ system: 'postgresql', operation: 'UPDATE', table: 'jobs' }, async () => {
      // update database
    })

    return { processed: true }
  }, { timeoutMs: 30_000 })
})
```

---

### Case 9: Docker & Containerized Microservices

In your `Dockerfile`, configure the entrypoint using `--import`:

```dockerfile
FROM node:20-alpine AS runner
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

# Use --import to guarantee zero-configuration ESM auto-instrumentation
CMD ["node", "--import", "@pulse-apm/node/register", "dist/server.js"]
```

---

## What `init()` Actually Needs

The Pulse SDK is designed to be **zero-configuration**:

```typescript
await init({
  apiKey: process.env.PULSE_API_KEY!,
})
```

### Why You Only Need `apiKey`:
* **`applicationName`**: Automatically read from `"name"` in your project's root `package.json`.
* **`release` (version)**: Automatically read from `"version"` in your `package.json`.
* **`environment`**: Authoritatively delivered from the Pulse APM backend based on your API key environment (`production`, `staging`, `preview`).
* **Instrumentation & Sampling**: Managed live via Remote Configuration and Killswitches from the Pulse Dashboard without redeploying.

---

## Fatal Anti-Patterns

### ❌ Anti-Pattern 1: Initializing Inside a Route Handler
```typescript
// ❌ WRONG: NEVER DO THIS
app.get('/api/data', async (req, res) => {
  await init({ apiKey: '...' }) // Will throw SDK_ALREADY_INITIALIZED or leak memory
})
```

### ❌ Anti-Pattern 2: Initializing After Creating Database Pools
```typescript
// ❌ WRONG: pg will NOT be instrumented!
import pg from 'pg'
const pool = new pg.Pool() // Pool created with unpatched pg driver!

import { init } from '@pulse-apm/node'
await init({ apiKey: '...' })
```

### ❌ Anti-Pattern 3: Missing the `await`
```typescript
// ❌ WRONG: Race condition! Traffic will arrive before remote config settles.
init({ apiKey: '...' })
app.listen(3000)

// ✅ CORRECT:
await init({ apiKey: '...' })
app.listen(3000)
```

### ❌ Anti-Pattern 4: Calling `init()` Multiple Times
```typescript
// ❌ WRONG: Pulse is a process singleton!
await init({ apiKey: 'key-1' })
await init({ apiKey: 'key-2' }) // Throws SDK_ALREADY_INITIALIZED
```

---

## How to Verify Initialization Succeeded

To confirm that the SDK has initialized and auto-instrumentations are hooked:

### 1. Enable Debug Logging
Pass `debug: true` or set the environment variable `PULSE_DEBUG=1`:
```typescript
await init({
  apiKey: process.env.PULSE_API_KEY!,
  debug: true,
})
```

### 2. Look for Startup Telemetry Logs
You will see output indicating successful registration:
```
[Pulse] Telemetry initialization started { endpoint: '/v1/init' }
[Pulse] [FeatureController] Started subsystem: tracing
[Pulse] [FeatureController] Started subsystem: errors
[Pulse] [FeatureController] Started subsystem: metrics
[Pulse] Auto-instrumentation hooks registered for: [http, https, pg, mysql2, redis, ioredis]
```

If you see those lines, your application is **100% verified and production-ready**.

