# Architecture Overview

## 1. System Mission & Philosophy

`@pulse-apm/node` is an enterprise-grade observability and distributed tracing SDK designed specifically for Node.js production workloads. As an observability agent embedded directly inside a customer's application process, the SDK adheres to a strict architectural philosophy:

> **The customer application owns the Node.js process and the event loop. Pulse is a guest.**

Under no circumstances may the SDK disrupt host application startup, stall request handling, allocate unbounded memory, block the event loop, throw unhandled promise rejections, or invoke `process.exit()`. If the Pulse backend control plane or ingestion pipeline is degraded, unreachable, slow, or returning errors, the customer application must continue operating normally and serving traffic.

---

## 2. High-Level Architectural Flow

```
                      +---------------------------------------+
                      |          Customer Application         |
                      +---------------------------------------+
                                          |
                      1. import '@pulse-apm/node' (or --import / -r)
                                          |
                                          v
                      +---------------------------------------+
                      |      Bootstrap Instrumentation        |
                      |  (Early monkey-patching of HTTP/DB)   |
                      +---------------------------------------+
                                          |
                                 2. await init()
                                          |
                                          v
                      +---------------------------------------+
                      |        Client State Machine           |
                      |    (created -> initializing)          |
                      +---------------------------------------+
                                          |
                                          +---------------------------------+
                                          |                                 |
                               3a. /v1/init Success             3b. /v1/init Failure
                                          |                                 |
                                          v                                 v
                      +-----------------------+         +-----------------------+
                      | Dynamic Remote Config |         |  Background Recovery  |
                      | & Subsystem Activation|         |        Worker         |
                      +-----------------------+         +-----------------------+
                                  |                                 |
                                  |                              Retries
                                  |                          (Backoff+Jitter)
                                  |                                 |
                                  v                                 v
                      +---------------------------------------------------------+
                      |                   Active Telemetry Pipeline             |
                      +---------------------------------------------------------+
                                          |
                      +---------------------------------------+
                      |         Event Capture APIs            |
                      |  (Spans, Errors, Requests, Metrics)   |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |     Processors & Scrubbers            |
                      |  (Normalizer, Sanitizer, Fingerprint) |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |       3-Tier Bounded Queue            |
                      |  (Critical, High, Normal + Ceiling)   |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |        Batch & Transport Router       |
                      |      (10 Route Multiplexed HTTP)      |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |        Ingestion Control Plane        |
                      +---------------------------------------+
```

---

## 3. Subsystem Breakdown

The SDK is composed of tightly decoupled subsystems residing in [`src/`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src):

### 3.1 Core Subsystems (`src/core/`)
- [`client.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/client.ts) — Holds global SDK instance state, options, and transitions the formal state machine (`created`, `initializing`, `initialized`, `recovering`, `stopping`, `stopped`).
- [`init.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts) — Implements `init()`, input validation, single-flight locking, control-plane polling, and subsystem bootstrapping.
- [`remote-config-client.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/remote-config-client.ts) — Dispatches HTTP POST requests to `/v1/init`, validates returned schemas, and updates runtime configurations.
- [`recovery-worker.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/recovery-worker.ts) — Autonomous background retry worker that polls `/v1/init` on failure using truncated exponential backoff and decorrelated jitter.
- [`feature-controller.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/feature-controller.ts) — Dynamically activates, throttles, or shuts down individual subsystems (tracing, metrics, errors, logs, crons, profiling) according to remote configuration entitlements.
- [`lifecycle.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts) — Coordinates graceful shutdown, flushes pending event queues, cancels background workers, and tears down auto-instrumentation hooks.

### 3.2 Telemetry Capture (`src/capture/`)
Provides the zero-overhead developer-facing entry points:
- `captureError(err, severity, context)`
- `captureRequest(req, res, duration)`
- `captureMessage(msg, level, context)`
- `captureEvent(event)`
- `captureMetric(metric)`
- `captureLog(msg, level, context)`
- `captureCronCheckIn(options)`
- `captureReplay(replayData)`

### 3.3 Tracing Subsystem (`src/tracing/`)
- [`tracer.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/tracer.ts) — Implements OpenTelemetry trace orchestration, manual span spans (`withSpan`, `withSpanSync`, `startSpan`), zero-overhead function wrapping (`Pulse.wrap`), and detached background traces (`withBackgroundSpan`).
- [`context-propagation.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/context-propagation.ts) — Manages W3C tracecontext and baggage headers across network boundaries.
- [`span-duration.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/span-duration.ts) — Computes truthful exclusive and inclusive span durations with event-loop lag correction.
- [`db-span.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/db-span.ts) — Specialized database span builder for query attribution.

### 3.4 Transport Layer (`src/transport/`)
- [`queue.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/queue.ts) — Bounded 3-tier event queue with strict global capacity ceiling and deterministic lower-priority shedding.
- [`transport-router.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-router.ts) — Multiplexes telemetry into 10 dedicated routes (`errors`, `events`, `traces`, `spans`, `metrics`, `logs`, `profiles`, `crons`, `requests`, `replays`).
- [`batch-manager.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts) — Aggregates queued events into compressed payload batches, respecting route batch limits and flush intervals.
- [`circuit-breaker.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/circuit-breaker.ts) — Tracks consecutive route delivery failures to trip the circuit and protect remote endpoints during prolonged outages.
- [`serialization-pool.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-pool.ts) — Dispatches CPU-intensive JSON serialization and gzip/brotli compression to worker threads.

### 3.5 Auto-Instrumentation (`src/instrumentation/`)
Integrates OpenTelemetry auto-instrumentations and proprietary monkey patching:
- Native HTTP/HTTPS, Axios, Undici, and `fetch`
- Express.js and Fastify middleware
- PostgreSQL (`pg`), MySQL2, Redis (`ioredis`, `redis`), MongoDB, Mongoose, and Prisma
- BullMQ and Nodemailer

---

## 4. Invariant Contracts

1. **Non-Blocking Telemetry:** All `capture*()` methods and tracing hooks return synchronously in microseconds; event queuing and ingestion occur asynchronously off the main thread.
2. **Single-Flight Coordination:** Multiple concurrent calls to `init()` coalesce into a single execution.
3. **Shutdown Dominance:** Once `shutdown()` is called, the SDK transitions to `'stopping'` and `'stopped'`. Delayed responses, recovery ticks, or late callbacks are immediately discarded.
4. **Deterministic Memory Plateaus:** Buffers operate with strict capacity limits. Peak heap usage remains bounded under extreme event pressure.
