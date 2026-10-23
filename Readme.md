# @lynktrace/node

> Enterprise-grade observability and distributed tracing SDK for Node.js applications, built natively on OpenTelemetry with automated framework and database interception, truthful timing attribution, adaptive load shedding, resilient offline disk spooling, continuous CPU profiling with duty-cycle cooling, system hardware metrics (CPU, GPU, Disk, GC, Event Loop), and isolated multi-route event transport.

[![Version](https://img.shields.io/badge/version-0.1.0--beta.3-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)]()
[![Type](https://img.shields.io/badge/module-ESM%20native-orange.svg)]()
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](package.json)

---

## Table of Contents

- [1. Overview & Architecture](#1-overview--architecture)
- [2. System Requirements & Runtime Compatibility](#2-system-requirements--runtime-compatibility)
- [3. Installation & Package Setup](#3-installation--package-setup)
- [4. Quick Start by Environment](#4-quick-start-by-environment)
  - [Standard Node.js Application](#standard-nodejs-application)
  - [Express.js Application](#expressjs-application)
  - [Fastify Application](#fastify-application)
  - [NestJS Application](#nestjs-application)
  - [Serverless & AWS Lambda (`wrapHandler`)](#serverless--aws-lambda-wraphandler)
  - [Background Workers & Job Queues (BullMQ / CLI)](#background-workers--job-queues-bullmq--cli)
- [5. Zero-Code Preload & Process Bootstrap](#5-zero-code-preload--process-bootstrap)
- [6. SDK Initialization (`init`)](#6-sdk-initialization-init)
  - [Complete `init()` Options Reference](#complete-init-options-reference)
  - [Fail-Open Initialization & Recovery Invariants](#fail-open-initialization--recovery-invariants)
- [7. Feature Guides: What to Use and What to Enable](#7-feature-guides-what-to-use-and-what-to-enable)
  - [Recommended Profile by Workload](#recommended-profile-by-workload)
  - [Disabling Subsystems Locally and Remotely](#disabling-subsystems-locally-and-remotely)
  - [Disabling Disk Storage for Serverless & Read-Only Disks](#disabling-disk-storage-for-serverless--read-only-disks)
  - [Emergency Operational Killswitches](#emergency-operational-killswitches)
- [8. Core Features & Capabilities](#8-core-features--capabilities)
  - [A. Error Tracking & Exception Capture](#a-error-tracking--exception-capture)
  - [B. Distributed Tracing & Span Lifecycle](#b-distributed-tracing--span-lifecycle)
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
- [9. Transport Pipeline & Resilience Guarantees](#9-transport-pipeline--resilience-guarantees)
  - [Per-Route Queue Isolation](#per-route-queue-isolation)
  - [Worker Thread Serialization & Event Loop Protection](#worker-thread-serialization--event-loop-protection)
  - [Strict LRU Retry Bookkeeping](#strict-lru-retry-bookkeeping)
  - [Circuit Breakers & Exponential Backoff](#circuit-breakers--exponential-backoff)
  - [Offline Disk Spooling & Deduplication](#offline-disk-spooling--deduplication)
- [10. Privacy, PII Scrubbing & Security](#10-privacy-pii-scrubbing--security)
- [11. Complete API Reference](#11-complete-api-reference)
- [12. Graceful Shutdown & Kubernetes Lifecycle](#12-graceful-shutdown--kubernetes-lifecycle)
- [13. Troubleshooting & Production Best Practices](#13-troubleshooting--production-best-practices)

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
- **Operating Systems**: Linux (Ubuntu, Debian, Alpine, RHEL, CentOS), macOS (Intel and Apple Silicon ARM64), Windows (x64, ARM64)
- **Container Runtimes**: Docker, Kubernetes, AWS ECS, Google Cloud Run, Azure Container Apps
- **Cloud Virtual Machines**: AWS EC2, Google Compute Engine, Azure VMs, Hostinger, DigitalOcean, Hetzner
- **Serverless Environments**: AWS Lambda, Vercel Functions, Google Cloud Functions, Netlify Functions
- **Module Systems**: ECMAScript Modules (`import`) and CommonJS (`require`)
- **TypeScript**: `>= 5.0.0` (Complete declarations bundled in `dist/index.d.ts` and `dist/internals.d.ts`)

---

## 3. Installation & Package Setup

Install the SDK using your preferred package manager:

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
If your project utilizes database ORMs or job queues, the SDK automatically hooks into them if installed:
- `@prisma/client`: `^5.0.0 || ^6.0.0 || ^7.0.0`
- `bullmq`: `^2.0.0 || ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0`

---

## 4. Quick Start by Environment

### Standard Node.js Application

```ts
import { init, captureException, captureMessage, flush } from '@lynktrace/node'

// Initialize the SDK at application startup
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'billing-service',
  applicationVersion: '1.0.0',
  environment: 'production',
})

try {
  captureMessage('Service initialized successfully', 'info')
  // Your business logic
} catch (error) {
  // Capture exception with stack trace, frame source context, and trace correlation
  captureException(error)
} finally {
  // Flush before process exit
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
  instrumentMiddleware: true,  // Profiles middleware execution durations
  minMiddlewareDurationMs: 2,  // Only emit child spans for middlewares taking >= 2ms
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

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'fastify-api',
})

const fastify = Fastify()

// Register the LynkTrace Fastify plugin
await fastify.register(lynktraceFastifyPlugin, {
  ignorePaths: ['/healthz'],
  captureHeaders: true,
})

fastify.get('/api/users/:id', async (request, reply) => {
  return { id: (request.params as any).id }
})

await fastify.listen({ port: 3000 })
```

### NestJS Application

```ts
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { init, lynktraceMiddleware, captureException } from '@lynktrace/node'
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common'

// Initialize before bootstrap
await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'nest-backend',
})

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

### Background Workers & Job Queues (BullMQ / CLI)

For queues, cron jobs, or batch CLI scripts, wrap asynchronous jobs in `withBackgroundSpan` and call `await flush()` before process exit:

```ts
import { init, withBackgroundSpan, captureException, flush } from '@lynktrace/node'
import { Worker } from 'bullmq'

await init({
  apiKey: process.env.LYNKTRACE_API_KEY!,
  applicationName: 'email-worker',
})

const worker = new Worker('emailQueue', async (job) => {
  return withBackgroundSpan('sendWelcomeEmail', async (span) => {
    span.setAttribute('job.id', job.id!)
    span.setAttribute('user.email', job.data.email)

    try {
      // Send email logic...
    } catch (err) {
      captureException(err)
      throw err
    }
  })
})

process.on('SIGTERM', async () => {
  await worker.close()
  await flush()
  process.exit(0)
})
```

---

## 5. Zero-Code Preload & Process Bootstrap

To capture telemetry from the very first line of code without modifying your application entrypoint, use the Node.js preload flag:

### ESM Applications (Node 18.19+ / 20.6+)
```bash
node --import @lynktrace/node/register dist/index.js
```

### CommonJS Applications
```bash
node -r @lynktrace/node/register dist/index.js
```

### Environment Variables
Configure credentials via standard environment variables:
```bash
export LYNKTRACE_API_KEY="lynktrace_live_xxxxxxxx"
export LYNKTRACE_APPLICATION_NAME="payment-service"
export LYNKTRACE_ENVIRONMENT="production"
export LYNKTRACE_RELEASE="v1.2.0"
```

---

## 6. SDK Initialization (`init`)

### Complete `init()` Options Reference

```ts
await init({
  apiKey: 'lynktrace_live_xxxxxxxx', // Required (or env LYNKTRACE_API_KEY)
  applicationName: 'order-service',  // Default: package.json name
  applicationVersion: '1.2.0',       // Default: package.json version
  environment: 'production',         // Default: process.env.NODE_ENV ?? 'development'
  release: '1.2.0-hotfix.1',         // Optional deployment release override
  serverName: 'ip-10-0-1-5',         // Default: os.hostname()
  debug: false,                      // Enable verbose diagnostic logging
  endpoint: 'https://api.lynktrace.com', // Optional custom control plane URL
  offlineQueue: true,                // Enable persistent disk queue (set false on Lambda/Serverless)
  beforeSend: (event) => {           // Optional custom filter/enrichment hook
    if (event.type === 'error' && event.error?.message?.includes('HealthCheck')) {
      return null                    // Drop unwanted events
    }
    return event
  },
  beforeBreadcrumb: (crumb) => crumb, // Optional breadcrumb interceptor
  plugins: [],                       // Custom SDK plugins
})
```

### Fail-Open Initialization & Recovery Invariants
1. **Control Plane Independence**: If the remote config endpoint (`/v1/init`) returns `500`, `503`, or times out, `init()` **never throws**. The SDK activates safe, baked-in internal defaults and launches a background recovery worker.
2. **Zero Request Path Blocking**: Incoming customer requests are served immediately; initialization failures never stall the event loop or prevent the server from binding ports.
3. **Automatic Reconnect**: When the control plane recovers, the SDK transparently switches to the authoritative remote configuration.

---

## 7. Feature Guides: What to Use and What to Enable

### Recommended Profile by Workload

| Workload Type | Tracing | Error Tracking | Request Capture | Metrics | Logging | Profiling | Offline Disk Queue | Recommended Batching |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| **Standard SaaS Web App** | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On | Optional (5% sample) | ✅ On | Standard (50 err / 500 spans / 2s flush) |
| **High-Throughput Microservice ($> 10\text{k req/s}$)** | ✅ On (adaptive) | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On (15s cooling duty) | ✅ On | High-throughput (1000 spans / 2.5s flush) |
| **Serverless (AWS Lambda / Vercel)** | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On | ❌ Off | ❌ **Off** (`offlineQueue: false`) | Instant (1 err / 25 spans / 250ms flush) |
| **Batch Workers / Job Queues** | ✅ Background | ✅ On | ❌ Off | ✅ On | ✅ On | Optional | ✅ On | Standard |
| **Read-Only Container Filesystems** | ✅ On | ✅ On | ✅ On | ✅ On | ✅ On | Optional | ❌ **Off** (or mount `/tmp`) | Standard |

### Disabling Subsystems Locally and Remotely

Subsystems can be enabled or disabled via Remote Configuration without redeploying code, or disabled locally in `init()`:

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

```ts
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

## 8. Core Features & Capabilities

### A. Error Tracking & Exception Capture

```ts
import { captureException, captureMessage, setTag, setUser } from '@lynktrace/node'

setUser({ id: 'user_9921', email: 'alex@example.com' })
setTag('customer_tier', 'enterprise')

try {
  throw new Error('Database connection timeout')
} catch (error) {
  // Captures stack trace, 5 lines of source code context before/after,
  // request headers, user context, breadcrumbs, and active trace ID:
  captureException(error, {
    level: 'fatal',
    extra: { query: 'SELECT * FROM orders', retries: 3 },
  })
}
```

### B. Distributed Tracing & Span Lifecycle

Traces conform to W3C `traceparent` standards and propagate automatically across HTTP calls, message queues, and database drivers:

```ts
import { getTraceId, getSpanId } from '@lynktrace/node'

const traceId = getTraceId()
const spanId = getSpanId()
console.log(`Current Trace ID: ${traceId}, Span ID: ${spanId}`)
```

### C. Custom Spans & Database Query Attribution

```ts
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

```ts
import { withBackgroundSpan } from '@lynktrace/node'

void withBackgroundSpan('generatePdfReport', async (span) => {
  span.setAttribute('report.format', 'pdf')
  await renderPdf()
})
```

### E. OpenTelemetry Metrics & Exponential Histograms

Built on the native OpenTelemetry Metrics SDK with $O(1)$ exponential histogram bucket aggregation:

```ts
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

```ts
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

#### Continuous CPU Profiling with Duty-Cycle Cooling (F-04 Hardened)
Continuous profiling samples the process in recurring chunks without accumulating overhead. Remote configuration allows setting a cooling period between chunks:

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
*Guarantees*:
- The V8 profiler runs for 60 seconds, flushes the profile chunk to the worker thread, cools off for 15 seconds, and then restarts.
- Enforces an 80% duty cycle limit, preventing continuous 100% profiler thread interrupts in production.
- Main-thread fallback is strictly rejected for profile serialization (F-01), protecting the event loop from multi-megabyte JSON stalls.

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
Uses `perf_hooks.monitorEventLoopDelay()` to calculate real-time p50, p90, p95, p99, and maximum event loop lag. Automatically triggers adaptive load shedding if lag exceeds safety thresholds ($> 50\text{ms}$).

#### 6. Container Memory Pressure & Hysteresis State Machine
Computes actual container memory limits from cgroups v1 (`/sys/fs/cgroup/memory/memory.limit_in_bytes`) and cgroups v2 (`/sys/fs/cgroup/memory.max`). Manages an adaptive pressure state machine:
- **HEALTHY** (Score $< 30$): Full telemetry capture.
- **ELEVATED** (Score $30\text{--}59$): Non-critical traces sampled down by 25%.
- **PRESSURED** (Score $60\text{--}79$): Traces sampled down by 50%, large profiles paused.
- **CRITICAL** (Score $\ge 80$): Non-critical telemetry dropped; critical reserve dedicated exclusively to fatal errors and crons.

### H. Structured Logging & Breadcrumbs

```ts
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

```ts
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

You can emit arbitrary custom business events with full type safety:

```ts
import { captureEvent } from '@lynktrace/node'

captureEvent({
  type: 'order_completed',
  orderId: 'ord-8831',
  amount: 249.99,
  currency: 'USD',
  timestamp: Date.now(),
})
```
*Guarantee*: Custom events route automatically to the `/v1/events` endpoint with `customType: event.type` metadata, ensuring zero event drops (F-02).

---

## 9. Transport Pipeline & Resilience Guarantees

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
Batches exceeding $50\text{KB}$ and all profile batches are offloaded to background worker threads (`SerializationPool`).
- **F-01 Protection**: Heavy profiles are forbidden from main-thread stringification fallback.
- If worker threads are busy or time out, profiles drop cleanly with `reason: 'serialization_failed'`, guaranteeing zero event loop freeze.

### Strict LRU Retry Bookkeeping
- **F-03 Protection**: Retried events update their access order in `firstAttemptTimestamps`.
- When retry tracking reaches capacity ($5,000$ entries), least-recently-used keys are evicted first, keeping active retry pipelines intact.

### Circuit Breakers & Exponential Backoff
- Per-route circuit breakers trip after consecutive HTTP 5xx errors or network drops.
- Retries follow exponential backoff with full jitter to avoid thundering herd spikes.

### Offline Disk Spooling & Deduplication
- During persistent network outages, undelivered events spool to disk in bounded NDJSON journals.
- Upon reconnection, events replay automatically with `X-LynkTrace-Replay: true` headers so the backend can deduplicate by `eventId`.

---

## 10. Privacy, PII Scrubbing & Security

The SDK features a multi-tiered security and PII scrubber:
- **Luhn Mod-10 Algorithm**: Automatically redacts Visa, Mastercard, American Express, and Discover PAN numbers.
- **Secrets & Credentials**: Automatically masks Social Security Numbers (SSN), AWS Access Keys, Stripe Secret Keys, JWT tokens, and Bearer authorization headers.
- **Deep Cycle Protection**: Recursively sanitizes nested objects up to 10 levels deep without stack overflows or circular reference crashes.

---

## 11. Complete API Reference

| Exported Function | Signature | Purpose |
|---|---|---|
| `init(options)` | `(options: InitOptions) => Promise<boolean>` | Initializes the SDK and connects to control plane. |
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
| `lynktraceMiddleware(options?)` | `(options?: ExpressOptions) => RequestHandler` | Express request and context binding middleware. |
| `expressErrorHandler()` | `() => ErrorRequestHandler` | Express unhandled route error middleware. |
| `lynktraceFastifyPlugin` | `FastifyPluginAsync` | Fastify request and error capture plugin. |
| `setUser(user)` | `(user: UserIdentity \| null) => void` | Binds user context to active scope. |
| `setTag(key, value)` | `(key: string, value: string) => void` | Binds custom tag to active scope. |
| `addBreadcrumb(crumb)` | `(crumb: Breadcrumb) => void` | Records navigation/action breadcrumb. |
| `getTraceId()` | `() => string \| undefined` | Returns current active W3C trace ID. |
| `getSpanId()` | `() => string \| undefined` | Returns current active span ID. |

---

## 12. Graceful Shutdown & Kubernetes Lifecycle

In containerized environments (Kubernetes, ECS), handle `SIGTERM` and `SIGINT` signals to flush buffered telemetry before termination:

```ts
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

## 13. Troubleshooting & Production Best Practices

### 1. Events Not Appearing in Dashboard
- Verify your API key starts with `lynktrace_live_` or `lynktrace_test_`.
- Check if `debug: true` is enabled in `init()` to view console diagnostic logs.
- Confirm outbound network egress to `https://api.lynktrace.com` on port `443` is permitted.

### 2. AWS Lambda Container Freezes
- Ensure you wrap handlers with `wrapHandler(handler, { flushTimeoutMs: 1500 })`.
- Ensure `offlineQueue: false` is configured in `init()` for Lambda functions.

### 3. High CPU Usage in Continuous Profiling
- Configure `coolingIntervalMs` (e.g. `15000`) in remote configuration so the profiler rests between chunks.

### 4. Memory Bounding in High-Throughput Services
- The SDK limits per-route in-memory queues to 1,000 events ($10\text{MB}$ total). Under extreme load bursts, the dual ring buffer safely drops oldest non-critical events while preserving critical errors and crons.

---

**© 2026 LynkTrace. All rights reserved. Enterprise observability with fail-open guarantees.**

