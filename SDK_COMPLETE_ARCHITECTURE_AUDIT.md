# Pulse SDK v2.0.0 — Complete Architecture Audit

**Audit Date:** 2026-05-21  
**Auditor:** OpenCode (Principal Observability Architect)  
**Version:** 2.0.0  
**Scope:** Full codebase analysis (63 source files, 14 directories)

---

## 1. Executive Summary

The Pulse SDK is a **well-architected, enterprise-grade observability SDK** with sophisticated features including OpenTelemetry integration, circuit breakers, retry budgets, persistent storage, and plan-based feature gating. The architecture follows a **pipeline pattern** with clear separation of concerns, but has critical flaws in the transport layer, event lifecycle, and histogram computation.

**Overall Grade:** **B+ (Architecture) / C (Production Readiness)**

**Strengths:**
- Modular design with clear boundaries
- Advanced transport resilience (circuit breaker, rate limiter, retry budget)
- Plan-based feature gating for SaaS monetization
- OpenTelemetry integration for tracing and metrics
- Comprehensive error deduplication

**Critical Weaknesses:**
- Event loss on retry requeue under memory pressure
- Synchronous event pipeline blocks event loop
- Incorrect histogram percentile computation
- Graceful shutdown does not flush queue
- Memory pressure does not gate event capture

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PULSE SDK v2.0.0 Architecture                      │
│                            Pipeline + Transport + OTel                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PUBLIC API SURFACE                             │
│  createSDK() │ captureError() │ captureRequest() │ captureMessage()          │
│  startSpan() │ withSpan() │ addBreadcrumb() │ captureMetric()              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             INITIALIZATION (init.ts)                        │
│  ┌──────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐    │
│  │ Option Parse │→│ Zod Schema│→│ Remote   │→│ Plan Resolution      │    │
│  │              │  │ Validate  │  │ Config   │  │ (merge + clamp)      │    │
│  └──────────────┘  └──────────┘  └──────────┘  └──────────────────────┘    │
│                     ↓                                                            │
│              ┌──────────────────────┐                                         │
│              │  Offline Fallback      │                                         │
│              │  (if init fails)     │                                         │
│              └──────────────────────┘                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EVENT PIPELINE (event-pipeline.ts)                  │
│  ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐        │
│  │ 1. Ensure   │→│ 2. Norm  │→│ 3. Sanit │→│ 4. Enrich│→│ 5. Dedu │        │
│  │    Base      │    │  ali    │    │  ize     │    │ Context  │    │ p      │        │
│  │    Fields    │    │         │    │         │    │         │    │        │        │
│  └─────────────┘ └──────────┘ └──────────┘ └─────────┘ └──────────┘        │
│        ↓              ↓            ↓            ↓           ↓                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌─────────────────┐    │
│  │ 6. Plugin │→│ 7. Event  │→│ 8. before│→│ 9. Sample│→│ 10. Queue      │    │
│  │    Process│    │ Process │    │ Send    │    │ (requests only) │    │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ └─────────────────┘    │
│        ↓                                                                    │
│  ┌─────────────────────────────────┐                                      │
│  │ 11. Persistent Storage (persist) │                                      │
│  └─────────────────────────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            TRANSPORT LAYER                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Event Queue  │→ │ Batch Drainer │→ │ Retry Logic │→ │ HTTP Sender  │ │
│  │ (bounded)    │  │ (tick timer) │  │ (budget)    │  │ (fetch)      │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘ │
│        ↑                                                    ↓               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Requeue Front│← │ Circuit      │← │ Rate         │← │ Compression  │ │
│  │ (on failure) │  │ Breaker      │  │ Limiter      │  │ (gzip/etc) │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SUBSYSTEMS & SERVICES                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ OpenTelemetry│  │ Error Dedu   │  │ Session      │  │ Plugin       │    │
│  │ Tracer/      │  │plicator      │  │ Manager      │  │ System       │    │
│  │ Metrics      │  │              │  │              │  │              │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Memory Monit │  │   Scope      │  │ Source Map   │  │ Persistent   │    │
│  │   (backpressure)│  (user/tags) │  │ Resolver     │  │   Storage    │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Auto-Instrument│  │ Slow Request│  │ Middleware   │  │   Logger     │    │
│  │ (HTTP/Express) │  │  Detector   │  │(Express)     │  │              │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Subsystem Deep-Dives

### 3.1 Core Client (`core/client.ts`)

**Pattern:** Singleton with immutable state  
**Thread Safety:** Not applicable (single-threaded Node.js)

| Component | Responsibility | Grade |
|-----------|--------------|-------|
| `SDKClient` | Singleton state container | B+ |
| `setOptions()` | Config + metadata + API key | A |
| `setResolvedConfig()` | Deep-frozen config | A |
| Plugin registry | Array-based, dedup by name | B |
| Breadcrumb buffer | RingBuffer (bounded) | A |
| Identity system | SHA-256 hash of API key | B+ |

**Risk:** `pluginRegistry` and `eventProcessorRegistry` are mutable arrays that can grow unbounded if users register plugins dynamically.

---

### 3.2 Event Pipeline (`core/event-pipeline.ts`)

**Entry Point:** `processEvent(rawEvent)`  
**Output:** Boolean (queued or dropped)

**Workflow (14 Steps):**

1. **Ensure Base Fields:** Assigns `eventId` (UUID) and `timestamp` (epoch ms)
2. **Pre-init Buffer:** If SDK not initialized, queues raw event
3. **Feature Flag Gate:** Checks `enableErrors`, `enablePerformance`, etc.
4. **Normalize:** Truncate oversized fields, fill defaults
5. **Sanitize:** PII scrubbing
6. **Enrich from Context:** Add `traceId`, `spanId`, `requestId`, breadcrumbs
7. **Error Deduplication:** Check fingerprint against suppression window
8. **Apply Scope:** User, tags, extras, contexts
9. **Plugin Event Processors:** Run `processEvent` on each plugin
10. **Event Processors:** Run user-registered processors
11. **beforeSend Hook:** User-provided callback
12. **Plugin beforeSend:** Plugin-provided callbacks
13. **Sampling:** Deterministic hash-based for request events
14. **Queue & Persist:** Add to event queue, write to persistent storage

**Performance:** O(plugins + processors) per event. Synchronous.

---

### 3.3 Transport Layer

#### 3.3.1 Event Queue (`transport/queue.ts`)

- **Max Size:** Configurable (default 1000)
- **Eviction Policy:** Oldest first (FIFO)
- **Requeue Front:** Pushes failed events back to head
- **Dead Letter:** Events removed by filter/requeue overflow

#### 3.3.2 Batcher (`transport/batcher.ts`)

- **Timer:** Self-rescheduling `setTimeout` (avoid setInterval overlap)
- **Guards:** Circuit breaker, rate limiter, memory pressure, concurrent flight limit
- **Memory Pressure:** Skips tick at critical level

#### 3.3.3 Retry Logic (`transport/retry.ts`)

- **Exponential Backoff:** Base 250ms, max 5000ms, with jitter
- **Retry Budget:** Global singleton (max 10 concurrent retries)
- **Retry-After Header:** Respected for server-side rate limiting

#### 3.3.4 HTTP Transport (`transport/http.ts`)

- **Fetch API:** Modern `fetch()` with `AbortController` for timeout
- **Compression:** gzip, brotli (configurable)
- **Error Classification:** 408, 429, 500+ = retryable

---

### 3.4 OpenTelemetry Integration

#### 3.4.1 Tracer (`tracing/tracer.ts`)

- **Provider:** `NodeTracerProvider` with `BatchSpanProcessor`
- **Exporters:** Custom `PipelineSpanExporter` routes to SDK event pipeline
- **Context Manager:** `AsyncLocalStorageContextManager`

#### 3.4.2 Metrics (`metrics/otel-adapter.ts`)

- **MeterProvider:** PulseMetricReader (custom) routes to event pipeline
- **Histograms:** Exponential histograms with O(1) recording
- **Views:** Pattern matching for `.duration`, `.latency`, etc.

---

### 3.5 Instrumentation

#### 3.5.1 Auto-Instrumentation (`instrumentation/auto-instrument.ts`)

- **HTTP Instrumentation:** Ignores SDK's own ingest URL
- **Express Instrumentation:** Framework-level middleware
- **Guard:** Ignores health/readiness endpoints

#### 3.5.2 Express Middleware (`instrumentation/express.ts`)

- **Request Capture:** Starts span, adds breadcrumbs, captures request events
- **Context Propagation:** Creates `ContextStore` for each request

---

## 4. Execution Flow Analysis

### 4.1 Request Lifecycle (Instrumented HTTP Request)

```
┌─────────────────────────────────────────────────────────────┐
│              INCOMING HTTP REQUEST                           │
│  (Express/Fastify/Raw HTTP)                                 │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Express Middleware (monitorMiddleware)                     │
│  ├── Create ContextStore (requestId, traceId, spanId)      │
│  ├── withContext() → AsyncLocalStorage.run()                │
│  ├── Extract traceparent from headers                        │
│  └── startSpan('HTTP GET /api/users')                      │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  User Route Handler                                          │
│  ├── addBreadcrumb('processing request')                   │
│  ├── await withSpan('db.query', ...)                        │
│  │   └── startSpan('db.query') → PulseSpan → OTel Span     │
│  ├── await withSpan('cache.get', ...)                       │
│  │   └── startSpan('cache.get')                            │
│  └── addBreadcrumb('route completed')                      │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Response Sent (Express 'finish' event)                    │
│  ├── span.end()                                            │
│  ├── captureRequest({ ...span data })                      │
│  └── processEvent({ type: 'request', ... })               │
│      ├── Feature flag check                                │
│      ├── Normalize, Sanitize, Enrich                      │
│      ├── Deduplicate (if error)                          │
│      ├── Plugin processing                                 │
│      ├── Sampling (if request)                           │
│      ├── Queue add                                         │
│      └── Persist to disk                                   │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Batch Tick (every ~5s)                                    │
│  ├── eventQueue.drain(batchSize)                          │
│  ├── sendEvents(events)                                    │
│  │   ├── createPayloads() (chunk by maxPayloadBytes)      │
│  │   └── postJson() → fetch() → ingestUrl                 │
│  └── Circuit breaker / Rate limiter / Retry budget        │
└─────────────────────────────────────────────────────────────┘
```

---

## 4.2 Error Lifecycle

```
throw new Error('DB connection failed')
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Global Error Handler (instrumentation/global-errors.ts)     │
│  ├── captureError(err)                                      │
│  │   └── processEvent({ type: 'error', ... })             │
│  │       ├── Normalize: stack trace parsing                │
│  │       ├── Sanitize: PII scrubbing                       │
│  │       ├── Fingerprint: hash of stack + message          │
│  │       ├── Deduplicate: check suppression window         │
│  │       ├── Enrich: add breadcrumbs from context          │
│  │       ├── Scope: add user, tags, extra                  │
│  │       ├── Plugin processing                             │
│  │       ├── beforeSend hook                               │
│  │       ├── Sampling: NOT applied to errors (100% sent)  │
│  │       ├── Queue add                                     │
│  │       └── Persist to disk                               │
│  └── addBreadcrumb('error captured')                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Lifecycle Analysis

### 5.1 SDK Lifecycle State Machine

| State | Description | Transitions |
|-------|-------------|-------------|
| `uninitialized` | Initial state | → `initializing` on `init()` |
| `initializing` | Handshake with backend | → `ready` on success; → `fallback` on failure |
| `ready` | Full telemetry | → `shutdown` on `shutdown()` |
| `fallback` | Offline mode (errors only) | → `ready` on reinit |
| `shutdown` | No telemetry | → `uninitialized` on `clear()` |

---

## 6. Telemetry Pipeline Analysis

### 6.1 Event Types

| Type | Origin | Sampling | Pipeline Steps |
|------|--------|----------|----------------|
| `error` | Global handlers, `captureError()` | ❌ None | Full pipeline |
| `request` | HTTP middleware | ✅ Deterministic | Full pipeline |
| `message` | `captureMessage()` | ❌ None | Full pipeline |
| `metric` | `captureMetric()`, OTel metrics | ❌ None | Full pipeline |
| `span` | OTel `startSpan()` | ❌ None | Full pipeline |

**CRITICAL GAP:** Only `request` events are sampled. Errors, messages, metrics, and spans are ALWAYS sent. This can overwhelm the queue during incidents.

---

## 7. Architecture Maturity Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| Modularity | 9/10 | Clear separation, good boundaries |
| Extensibility | 8/10 | Plugin system is well-designed |
| Resilience | 7/10 | CB, retry budget, rate limiter |
| Performance | 5/10 | Sync pipeline, blocking I/O |
| Scalability | 5/10 | Single-threaded, no worker pool |
| OTel Integration | 7/10 | Good adapter, histogram bugs |
| Production Safety | 6/10 | Good error handling, data loss on retry |
| Operational Visibility | 8/10 | `getSDKHealth()` is comprehensive |
| **Overall** | **6.5/10** | Solid but needs critical fixes |

---

## 8. Critical Architecture Gaps

1. **No Async Worker Pool:** Event pipeline runs on main thread
2. **No Backpressure from Queue to Capture:** Can queue overflow
3. **No Multi-Region Routing:** Single ingest URL
4. **No Retry Dead Letter Queue:** Failed events lost on requeue overflow
5. **No Event TTL in Queue:** Events can sit forever (but queue is bounded)
6. **No Graceful Shutdown Hook:** Queue not flushed on SIGTERM

---
