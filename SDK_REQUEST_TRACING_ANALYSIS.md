# Pulse SDK v2.0.0 — Request & Tracing Lifecycle Analysis

**Scope:** Complete lifecycle of incoming requests, trace context propagation, span creation, child span propagation, error capture, queueing, batching, export, and graceful shutdown. Identification of every point where correlation may break, spans may duplicate, or context may leak.

---

## 1. Incoming Request Lifecycle

### 1.1 Entry Points

```
┌─────────────────────────────────────────────────────────────┐
│                    REQUEST ENTRY POINTS                     │
├─────────────────────────────────────────────────────────────┤
│                                                            │
│  1. Express Middleware (instrumentation/express.ts)       │
│     └── Triggers: HTTP server receives request            │
│                                                            │
│  2. HTTP Client Hook (instrumentation/auto-instrument.ts)   │
│     └── Triggers: Outgoing fetch/http request              │
│                                                            │
│  3. Manual: startSpan('operation', ...)                   │
│     └── Triggers: User code explicitly creates span        │
│                                                            │
│  4. Auto-Instrumentation: OTel HttpInstrumentation        │
│     └── Triggers: All HTTP traffic                         │
│                                                            │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Full Request Flow (Express)

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 1: Express receives HTTP request                     │
│  ├── Method: GET, Path: /api/users                          │
│  └── Headers: { 'traceparent': '00-abc...-def...-01' }      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 2: monitorMiddleware() invoked                     │
│  ├── Extract traceparent from headers                       │
│  ├── extractTraceContext(headers) → OTel Context            │
│  ├── Create new ContextStore:                               │
│  │   ├── requestId: uuid()                                  │
│  │   ├── traceId: from traceparent or new uuid()           │
│  │   └── spanId: from traceparent or new span()            │
│  └── withContext(store, ...) → AsyncLocalStorage.run()    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 3: startSpan('HTTP GET /api/users')                  │
│  ├── OTel tracer creates span                             │
│  ├── Span linked to parent via extracted context            │
│  ├── span.start() sets startTime                            │
│  └── span becomes active in AsyncLocalStorage context       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 4: User route handler executes                      │
│  ├── await withSpan('db.query', ...) → nested span        │
│  ├── await withSpan('cache.get', ...) → nested span       │
│  └── addBreadcrumb('fetched user list')                   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 5: Response sent (Express 'finish' event)            │
│  ├── span.end() sets endTime                                │
│  ├── span.status = 'ok' or 'error'                         │
│  └── captureRequest({ status, duration, ... })            │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 6: Request event flows through pipeline              │
│  ├── processEvent({ type: 'request', ... })                │
│  ├── Enrich with: traceId, spanId, breadcrumbs            │
│  ├── Sampling: deterministic hash of traceId              │
│  └── Queue add + Persist to disk                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Trace Context Propagation Analysis

### 2.1 W3C Trace Context

```
┌─────────────────────────────────────────────────────────────┐
│              TRACE CONTEXT PROPAGATION FLOW                  │
├─────────────────────────────────────────────────────────────┤
│                                                            │
│  INCOMING (Server receives request)                        │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│  │ HTTP Headers│───→│ extractTrace│───→│ OTel Context│  │
│  │ traceparent │    │ Context()   │    │ (active)    │  │
│  └─────────────┘    └─────────────┘    └─────────────┘   │
│                              │                            │
│                              ▼                            │
│                         ┌──────────┐                      │
│                         │Creates or│                      │
│                         │reuses    │                      │
│                         │traceId   │                      │
│                         └──────────┘                      │
│                                                            │
│  OUTGOING (Server makes request)                           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│  │ OTel Context│───→│ injectTrace │───→│ HTTP Headers│  │
│  │ (active)    │    │ Context()   │    │ traceparent │  │
│  └─────────────┘    └─────────────┘    └─────────────┘   │
│                                                            │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Context Drift Risk

| Scenario | Risk | Status |
|----------|------|--------|
| AsyncLocalStorage not set | `getTraceId()` returns `undefined` | ⚠️ Handled (returns undefined) |
| Timer callback (setTimeout) | Context NOT propagated | 🔴 **CRITICAL** |
| Event listener | Context NOT propagated | 🔴 **CRITICAL** |
| Worker thread | Context NOT propagated | 🔴 **CRITICAL** |
| Promise chain break | Context lost | ⚠️ Partially handled |

**Example of context drift:**

```typescript
// ❌ BAD: Context lost in setTimeout
app.get('/api', async (req, res) => {
  const span = startSpan('handler')
  
  setTimeout(() => {
    // ❌ getTraceId() returns undefined here!
    // AsyncLocalStorage context is not propagated through timers
    
    addBreadcrumb('timeout fired') // ❌ Silently lost
  }, 1000)
  
  span.end()
})

// ✅ GOOD: Use withContext or manually propagate
app.get('/api', async (req, res) => {
  const span = startSpan('handler')
  const ctxStore = getRequestContext()
  
  setTimeout(() => {
    withContext(ctxStore, () => {
      addBreadcrumb('timeout fired') // ✅ Preserved
    })
  }, 1000)
  
  span.end()
})
```

---

## 3. Span Creation & Child Propagation

### 3.1 Span Hierarchy

```
Parent Span: "HTTP GET /api/users" (traceId: abc, spanId: def)
│
├── Child Span 1: "db.query" (traceId: abc, spanId: 123, parent: def)
│   └── Child Span 1.1: "db.connection" (traceId: abc, spanId: 456, parent: 123)
│
├── Child Span 2: "cache.get" (traceId: abc, spanId: 789, parent: def)
│
└── Child Span 3: "external.api" (traceId: abc, spanId: abc, parent: def)
    └── SpanContext propagated via headers to external service
```

### 3.2 Span Creation Flow

```typescript
// tracing/tracer.ts:198
export function startSpan(name: string, options?: SpanOptions): PulseSpan {
  if (!tracer) {
    // Tracing not initialized - return no-op span
    return new PulseSpan(noopTracer.startSpan(name))
  }
  
  const otelOptions: OTelSpanOptions = {}
  if (options?.attributes) otelOptions.attributes = options.attributes
  if (options?.startTime) otelOptions.startTime = options.startTime
  
  const span = tracer.startSpan(name, otelOptions)
  return new PulseSpan(span)
}
```

**Issues:**

1. **No parent span context** passed to `tracer.startSpan()` → Spans will be ROOT spans
2. **`withSpan` does not set OTel active context** → Child spans won't have correct parent

```typescript
// ❌ BROKEN: Child spans become siblings, not children
export async function withSpan<T>(name: string, fn: (span: PulseSpan) => T): Promise<T> {
  const span = startSpan(name) // Not set as active!
  
  try {
    const result = await fn(span)
    span.setStatus('ok')
    return result
  } finally {
    span.end()
  }
}

// ✅ FIXED: Set span as active in OTel context
export async function withSpan<T>(name: string, fn: (span: PulseSpan) => T): Promise<T> {
  const span = startSpan(name)
  const spanContext = trace.setSpan(context.active(), span)
  
  return context.with(spanContext, async () => {
    try {
      const result = await fn(span)
      span.setStatus('ok')
      return result
    } finally {
      span.end()
    }
  })
}
```

---

## 4. Error Capture & Span Correlation

### 4.1 Error Capture Flow

```
┌─────────────────────────────────────────────────────────────┐
│  UNCAUGHT EXCEPTION IN REQUEST HANDLER                      │
├─────────────────────────────────────────────────────────────┤
│                                                            │
│  throw new Error('DB connection failed')                   │
│           │                                                 │
│           ▼                                                 │
│  ┌─────────────────────────┐                              │
│  │ Global Error Handler     │                              │
│  │ (instrumentation/        │                              │
│  │  global-errors.ts)        │                              │
│  └─────────────────────────┘                              │
│           │                                                 │
│           ▼                                                 │
│  captureError(err)                                          │
│           │                                                 │
│           ▼                                                 │
│  processEvent({ type: 'error', ... })                      │
│           │                                                 │
│           ▼                                                 │
│  Enrichment:                                                 │
│  ├── getRequestContext() → traceId, spanId                │
│  ├── breadcrumbs.toArray()                                │
│  ├── user, tags, extras                                   │
│  └── Enrich event with trace context                       │
│           │                                                 │
│           ▼                                                 │
│  Queue add → eventQueue.add(event)                        │
│           │                                                 │
│           ▼                                                 │
│  Batcher tick → send to backend                           │
│                                                            │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Error-to-Span Correlation

| Event Type | traceId | spanId | parentSpanId | Correlation |
|------------|---------|--------|--------------|-------------|
| Error | ✅ Yes | ✅ Yes | ❌ No | Partial |
| Request | ✅ Yes | ✅ Yes | ❌ No | Partial |
| Message | ✅ Yes | ✅ Yes | ❌ No | Partial |
| Metric | ✅ Yes | ❌ No | ❌ No | Weak |
| Span (OTel) | ✅ Yes | ✅ Yes | ✅ Yes | Full |

**CRITICAL GAP:** Custom events (error, request, message) do NOT include `parentSpanId`. This means you cannot reconstruct the call tree from custom events alone.

---

## 5. Queue, Batch & Export Lifecycle

### 5.1 Event Flow Through Transport

```
┌─────────────────────────────────────────────────────────────┐
│                    TRANSPORT PIPELINE                        │
├─────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│  │   Event     │───→│   Event     │───→│   Batch     │    │
│  │   Queue     │    │   Drainer   │    │   Sender    │    │
│  │   (FIFO)    │    │   (tick)    │    │   (fetch)   │    │
│  └─────────────┘    └─────────────┘    └─────────────┘    │
│        ↑                   │                   │            │
│        │                   │                   │            │
│  ┌──────────┐            ▼                   ▼            │
│  │ Requeue  │      ┌─────────────┐    ┌─────────────┐      │
│  │ (retry)  │←─────│ Circuit     │←───│ Rate        │      │
│  │          │      │ Breaker     │    │ Limiter     │      │
│  └──────────┘      └─────────────┘    └─────────────┘      │
│                                                            │
│  SUCCESS PATH:                                             │
│  eventQueue.drain() → sendEvents() → fetch() → 200 OK    │
│                                                            │
│  FAILURE PATH:                                             │
│  eventQueue.drain() → sendEvents() → fetch() → ERROR     │
│                       ↓                                     │
│                  eventQueue.requeueFront()                   │
│                       ↓                                     │
│                  Next tick → retry (with backoff)         │
│                                                            │
│  DROP PATH:                                                │
│  eventQueue.drain() → sendEvents() → ERROR x3          │
│                       ↓                                     │
│                  Requeue → queue full → DROP               │
│                       ↓                                     │
│                  deadLetterCount++                         │
│                                                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Async Context Propagation

### 6.1 Current Implementation

```typescript
// core/context.ts:40
export const asyncLocalStorage = new AsyncLocalStorage<ContextStore>()

// core/context.ts:156
export function withContext<T>(store: ContextStore, fn: () => T): T {
  return asyncLocalStorage.run(store, fn)
}
```

### 6.2 Propagation Quality

| Async Construct | Supported | Notes |
|-----------------|-----------|-------|
| `async/await` | ✅ Yes | Native support |
| `Promise.then()` | ✅ Yes | Through microtask queue |
| `Promise.all()` | ✅ Yes | Each promise gets context |
| `setTimeout` | ❌ No | Context lost |
| `setInterval` | ❌ No | Context lost |
| `EventEmitter` | ❌ No | Context lost |
| `Worker` | ❌ No | Isolated context |
| `process.nextTick` | ⚠️ Partial | May lose context |

### 6.3 Fix for Timer Propagation

```typescript
// ❌ CURRENT: Context lost in timers
setTimeout(() => {
  getTraceId() // undefined
}, 1000)

// ✅ FIX: Bind context to timer
import { AsyncLocalStorage } from 'async_hooks'
const als = new AsyncLocalStorage<ContextStore>()

function setContextTimeout(callback, delay, ...args) {
  const store = als.getStore()
  return setTimeout(() => {
    if (store) {
      als.run(store, callback, ...args)
    } else {
      callback(...args)
    }
  }, delay)
}
```

---

## 7. Trace & Request Correlation

### 7.1 Correlation Quality Matrix

| What | Source | Reliability | Notes |
|------|--------|-------------|-------|
| `traceId` | OTel SpanContext | ✅ High | Stable through span tree |
| `spanId` | OTel SpanContext | ✅ High | Unique per span |
| `parentSpanId` | OTel SpanContext | ❌ Missing | Not in custom events |
| `requestId` | Custom UUID | ⚠️ Medium | Generated, not linked to trace |
| `sessionId` | SessionManager | ⚠️ Medium | Optional, may be null |
| `userId` | Scope | ⚠️ Medium | Optional, may be null |

### 7.2 Full Trace Reconstruction

```
│ TRACE: trace-abc-123 │
│
├── Span 1: "HTTP GET /api/users" (spanId: sp-1)
│   ├── Custom Event: request (traceId: trace-abc-123, spanId: sp-1)
│   │   ├── breadcrumbs: [...]
│   │   └── user: { id: 'user-1' }
│   │
│   ├── Span 2: "db.query" (spanId: sp-2, parent: sp-1)
│   │   └── Custom Event: span (traceId: trace-abc-123, spanId: sp-2)
│   │
│   └── Span 3: "cache.get" (spanId: sp-3, parent: sp-1)
│       └── Custom Event: span (traceId: trace-abc-123, spanId: sp-3)
│
└── Error: "DB connection failed"
    ├── Event: error (traceId: trace-abc-123, spanId: sp-1)
    ├── breadcrumbs: [...]
    └── stack trace
```

**Gaps:**
- No `parentSpanId` in custom events → Can't build tree from events alone
- `requestId` is independent of `spanId` → Two IDs for same request

---

## 8. Graceful Shutdown

### 8.1 Current Shutdown Flow

```typescript
// transport/batcher.ts:117
export function stopBatcher() {
  isRunning = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  inFlightCount = 0
  circuitBreaker.reset() // ❌ Dangerous
  rateLimiter.reset()
}
```

**Missing:**
- No `flush()` call to drain remaining events
- No waiting for in-flight batches to complete
- Circuit breaker reset = lose failure history

### 8.2 Optimal Shutdown Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    GRACEFUL SHUTDOWN                         │
├─────────────────────────────────────────────────────────────┤
│                                                            │
│  1. Receive SIGTERM/SIGINT                                  │
│           │                                                │
│           ▼                                                │
│  2. Set isRunning = false (stop accepting new events)     │
│           │                                                │
│           ▼                                                │
│  3. Stop batch timer (no new ticks)                        │
│           │                                                │
│           ▼                                                │
│  4. Wait for in-flight batches to complete (max 30s)     │
│           │                                                │
│           ▼                                                │
│  5. Force flush remaining events (with retry ×3)           │
│           │                                                │
│           ▼                                                │
│  6. If events remain, persist to disk (NDJSON)          │
│           │                                                │
│           ▼                                                │
│  7. Shutdown OTel tracer (flush spans)                     │
│           │                                                │
│           ▼                                                │
│  8. Shutdown OTel metrics (flush metrics)                  │
│           │                                                │
│           ▼                                                │
│  9. Close all connections                                  │
│           │                                                │
│           ▼                                                │
│  10. Exit process (or allow natural exit)                  │
│                                                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Summary: 17 Lifecycle Risks Identified

| # | Risk | Severity | Location |
|---|------|----------|----------|
| 1 | Events lost on retry requeue | 🔴 CRITICAL | `transport/queue.ts` |
| 2 | Graceful shutdown doesn't flush | 🔴 CRITICAL | `transport/batcher.ts` |
| 3 | Context lost in timers | 🔴 CRITICAL | `core/context.ts` |
| 4 | Child spans lack parent context | 🔴 CRITICAL | `tracing/tracer.ts` |
| 5 | Circuit breaker reset on stop | 🔴 CRITICAL | `transport/batcher.ts` |
| 6 | AsyncLocalStorage not in Workers | 🔴 CRITICAL | Architecture |
| 7 | No parentSpanId in custom events | 🟠 HIGH | `tracing/tracer.ts` |
| 8 | RequestId independent of spanId | 🟠 HIGH | `core/context.ts` |
| 9 | Event loop blocking (sync I/O) | 🟠 HIGH | `storage/persistent-storage.ts` |
| 10 | In-flight batches lost | 🟠 HIGH | `transport/batcher.ts` |
| 11 | Context lost in EventEmitter | 🟡 MEDIUM | Architecture |
| 12 | No timeout on graceful flush | 🟡 MEDIUM | `core/lifecycle.ts` |
| 13 | Span export vs event pipeline race | 🟡 MEDIUM | `tracing/tracer.ts` |
| 14 | Metrics not flushed on shutdown | 🟡 MEDIUM | `metrics/otel-adapter.ts` |
| 15 | Sampling only for requests | 🟡 MEDIUM | `core/event-pipeline.ts` |
| 16 | Breadcrumb context drift | 🟡 MEDIUM | `core/context.ts` |
| 17 | HTTP connection pool exhaustion | 🟢 LOW | `transport/http.ts` |

---

## 10. Recommendations

| Priority | Action | Impact |
|----------|--------|--------|
| P0 | Fix `withSpan` to set active context | Fixes broken trace trees |
| P0 | Add `parentSpanId` to custom events | Enables full correlation |
| P0 | Implement graceful shutdown flush | Prevents data loss |
| P1 | Add `bindContext` for timers/Emitters | Prevents context drift |
| P1 | Use Worker threads for transport | Removes event loop blocking |
| P2 | Unify `requestId` and `spanId` | Simplifies correlation |
| P2 | Sample all event types (configurable) | Prevents queue overflow |

---
