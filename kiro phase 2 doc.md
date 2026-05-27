# SDK-NODE ENTERPRISE-GRADE ARCHITECTURE ANALYSIS

## PHASE 2 — FEATURE-BY-FEATURE DEEP DOCUMENTATION

This document provides exhaustive, module-level documentation for every feature in the Pulse SDK (`sdk-node`). Each section covers internal architecture, state management, full lifecycle, async boundaries, and event-loop behavior. Intended for senior engineers, SREs, platform engineers, and observability architects.

---

## TABLE OF CONTENTS

1. [Transport Layer](#1-transport-layer)
   - 1.1 EventQueue (3-Tier Priority Queue)
   - 1.2 BatchManager
   - 1.3 Batcher (Legacy)
   - 1.4 CircuitBreaker
   - 1.5 Retry System & RetryBudget
   - 1.6 LoadShedder
   - 1.7 RateLimiter (TokenBucket & SlidingWindow)
   - 1.8 ConnectionManager
   - 1.9 Sender
   - 1.10 TransportRouter
2. [Tracing](#2-tracing)
   - 2.1 Tracer & PipelineSpanExporter
   - 2.2 PulseSpan
   - 2.3 Context Propagation (W3C)
   - 2.4 RemoteConfigSampler
   - 2.5 SamplingEngine
3. [Metrics](#3-metrics)
   - 3.1 MetricsRegistry
   - 3.2 OTel Adapter
   - 3.3 CardinalityGovernor
4. [Processors](#4-processors)
   - 4.1 Normalizer
   - 4.2 Sanitizer (PII Scrubber)
   - 4.3 ErrorDeduplicator
5. [Core Engine](#5-core-engine)
   - 5.1 ConfigManager
   - 5.2 KillswitchEngine
   - 5.3 FeatureController
   - 5.4 LimitsEngine
   - 5.5 Event Pipeline
6. [Storage](#6-storage)
   - 6.1 PersistentStorage
   - 6.2 PersistenceGovernor
7. [Session](#7-session)
   - 7.1 SessionManager
8. [Utilities](#8-utilities)
   - 8.1 AdaptivePressureMonitor
   - 8.2 MemoryPressureMonitor (Backpressure)

---

---

## 1. TRANSPORT LAYER

The transport layer is the most complex subsystem in the SDK. It is responsible for accepting events from the event pipeline, queuing them by priority, batching them for efficiency, and delivering them to the backend ingestion endpoint with full resilience guarantees.

---

### 1.1 EventQueue — 3-Tier Priority Queue

**File:** `src/transport/queue.ts`

#### Feature Overview

The `EventQueue` is the central in-memory buffer between the event pipeline and the network sender. It implements a three-tier priority system that ensures high-value telemetry (errors, crashes) is never dropped under load while low-value telemetry (metrics, messages) is shed first.

**Why it exists:** A flat FIFO queue would drop errors and crashes under load with the same probability as metrics. The priority queue ensures observability SLOs are met even during traffic spikes.

**Systems that depend on it:** `Batcher`, `BatchManager`, `TransportRouter`, `event-pipeline.ts`

#### Internal Architecture

```
EventQueue
├── tiers: Record<EventPriority, QueueTier>
│   ├── critical  → maxSize = 40% of total (errors, crashes)
│   ├── high      → maxSize = 40% of total (requests, spans)
│   └── normal    → maxSize = 20% of total (metrics, messages)
├── retryQueue: Event[]          ← highest drain priority
├── maxSize: number              ← total capacity (default 1000)
├── deadLetterCount: number      ← events permanently dropped
├── shuttingDown: boolean        ← rejects new events when true
└── dropHandler: callback        ← notified on every drop
```

**Priority Classification (auto-detected from event.type):**

| Event Type | Priority | Tier Allocation |
|------------|----------|-----------------|
| `error` | `critical` | 40% of queue |
| `request`, `span` | `high` | 40% of queue |
| `metric`, `message`, others | `normal` | 20% of queue |

#### State Management

- **Tier overflow handling:** When a tier is full, the queue attempts to shed lower-priority events to make room. `critical` events can shed `high` and `normal`. `high` events can shed `normal`. `normal` events are dropped if their tier is full.
- **Retry queue:** Events that failed to send are re-queued at the front via `requeueFront()`. The retry queue is drained first on every `drain()` call, giving failed events priority over new ones.
- **Shutdown safety:** `setShuttingDown(true)` causes all new `add()` calls to return `false` immediately, preventing new events from entering during graceful shutdown.

#### Full Lifecycle

```
1. INITIALIZATION
   new EventQueue(maxSize=1000)
   → tiers created: critical(400), high(400), normal(200)
   → retryQueue = []
   → shuttingDown = false

2. EVENT ADMISSION (add)
   event arrives → getPriority(event) → classify tier
   → if shuttingDown → notifyDrop('shutdown_rejected') → return false
   → if tier.events.length >= tier.maxSize
       → if critical: try shedLowerPriority('high') → shed 1 high event
       → if high: try shedLowerPriority('normal') → shed 1 normal event
       → if normal: drop → notifyDrop('queue_full') → return false
   → tier.events.push(event) → return true

3. DRAIN (for batch send)
   drain(batchSize)
   → retryQueue.splice(0, remaining) first
   → then critical.splice(0, remaining)
   → then high.splice(0, remaining)
   → then normal.splice(0, remaining)
   → returns Event[]

4. RETRY RE-QUEUE (on send failure)
   requeueFront(events)
   → events inserted at front of retryQueue (reverse order)
   → if retryQueue.length > maxSize*0.5 → spill excess to disk

5. SHUTDOWN
   setShuttingDown(true)
   → all new add() calls rejected
   → persistRemaining(persist) → drainAll() → persist each event
```

#### Async Boundaries

- All operations are **synchronous** — no async/await in the queue itself
- `persistRemaining()` is async (calls `persist()` which may write to disk)
- The queue is designed to be called from the event loop without blocking

---

### 1.2 BatchManager

**File:** `src/transport/batch-manager.ts`

#### Feature Overview

`BatchManager` is the per-route batching engine used by `TransportRouter`. It accepts individual events, accumulates them into batches, and flushes them either when the batch is full or when a timer fires.

**Why it exists:** Sending one HTTP request per event would be catastrophically inefficient. Batching amortizes HTTP overhead across many events.

#### Internal Architecture

```
BatchManager
├── options: BatchManagerOptions
│   ├── route: EnterpriseRoute
│   ├── sender: (batch) => Promise<void>
│   ├── maxBatchSize: number          (default: 100)
│   ├── maxWaitMs: number             (default: 5000ms)
│   ├── maxPayloadBytes: number
│   ├── maxConcurrency: number        (default: 3)
│   └── circuitBreaker: CircuitBreaker
├── buffer: SDKEvent[]               ← pending events
├── inFlight: number                 ← concurrent sends in progress
├── timer: NodeJS.Timeout | null     ← flush timer
├── shutdownPromise: Promise | null  ← shutdown coordination
└── stats: BatchManagerStats
```

#### Full Lifecycle

```
1. INITIALIZATION
   new BatchManager(options)
   → buffer = []
   → inFlight = 0
   → timer = null

2. EVENT ENQUEUE (enqueue)
   enqueue(event) → boolean
   → if shutting down → return false
   → buffer.push(event)
   → pump() → check if flush needed
   → ensureTimer() → arm flush timer if not running

3. PUMP (internal flush trigger)
   pump(force=false)
   → if buffer.length >= effectiveMaxBatchSize() → flush immediately
   → if maxWaitElapsed() → flush immediately
   → if force → flush immediately

4. BATCH SEND (sendBatch)
   sendBatch(batch)
   → check circuitBreaker.canExecute() → skip if OPEN
   → inFlight++
   → await options.sender(batch)
   → circuitBreaker.recordSuccess()
   → inFlight--
   → on failure: circuitBreaker.recordFailure() → re-enqueue

5. TIMER-BASED FLUSH
   ensureTimer() → setTimeout(maxWaitMs)
   → timer fires → pump(force=true) → flush whatever is in buffer
   → clearTimer() after flush

6. SHUTDOWN
   shutdown()
   → flush() → drain all remaining events
   → await all in-flight sends
   → clearTimer()
```

#### Async Boundaries

- `enqueue()` is **synchronous** — returns immediately
- `flush()` is **async** — awaits all in-flight sends
- `sendBatch()` is **async** — awaits HTTP response
- Timer callback is async — `setTimeout` fires in event loop macrotask queue
- Concurrency controlled by `inFlight` counter vs `maxConcurrency`

---

### 1.3 Batcher (Legacy Single-Queue)

**File:** `src/transport/batcher.ts`

#### Feature Overview

The legacy batcher operates on the global `eventQueue` singleton. It is the original transport mechanism before `TransportRouter` and per-route `BatchManager` were introduced. Still used as the fallback path.

#### Internal State (Module-Level Singletons)

```
timer: NodeJS.Timeout | null
batchSize: number                    (default from constants)
flushIntervalMs: number              (default from constants)
inFlightCount: number
maxConcurrentSends: number           (default: 3)
isRunning: boolean
inFlightFlush: Promise<void> | null  ← single-flight flush lock

circuitBreaker: CircuitBreaker       (failureThreshold=5, resetTimeout=30s)
rateLimiter: TokenBucketRateLimiter  (capacity=10, refillRate=2/s)
memoryMonitor: MemoryPressureMonitor (elevated=70%, critical=90%)
```

#### Full Lifecycle

```
1. START (startBatcher)
   → update parameters (idempotent)
   → if already running → return (no timer stacking)
   → isRunning = true
   → memoryMonitor.start()
   → scheduleNextTick()

2. TICK CYCLE (every flushIntervalMs)
   tick()
   → if queue empty → skip
   → if !client.initialized → skip (SDK not ready)
   → if memory.level === 'critical' → skip (protect heap)
   → if !circuitBreaker.canExecute() → skip (endpoint down)
   → if !rateLimiter.tryAcquire() → skip (rate limited)
   → if inFlightCount >= maxConcurrentSends → skip (concurrency limit)
   → events = eventQueue.drain(batchSize)
   → inFlightCount++
   → await sendEvents(events)
   → circuitBreaker.recordSuccess()
   → persistentStorage.discard(events)
   → on failure: circuitBreaker.recordFailure()
                 persistentStorage.persist(events)
                 eventQueue.requeueFront(events)
   → inFlightCount--
   → scheduleNextTick() (reschedule)

3. FLUSH (flush) — single-flight lock
   → if inFlightFlush exists → return same promise (dedup)
   → drainPendingEventProcessing() (wait for pipeline)
   → while queue not empty:
       → drain(batchSize) → sendEvents()
       → on failure: persist + requeue + attempts++
       → if attempts >= 3: persist remaining → break
   → persistentStorage.flush()

4. STOP (stopBatcher)
   → isRunning = false
   → clearTimeout(timer)
   → memoryMonitor.stop()
   → circuitBreaker.reset()
   → rateLimiter.reset()
   → inFlightCount = 0
```

#### Key Design: Single-Flight Flush Lock

```typescript
// Concurrent flush calls (shutdown + signal handler racing) share one promise
if (inFlightFlush) {
  return inFlightFlush  // return same promise — no double-send
}
inFlightFlush = (async () => { ... })().finally(() => { inFlightFlush = null })
```

---

### 1.4 CircuitBreaker

**File:** `src/transport/circuit-breaker.ts`

#### Feature Overview

The `CircuitBreaker` prevents cascading failures when the ingestion endpoint is unavailable. Instead of hammering a failing endpoint with retries, it opens the circuit and fast-fails requests, allowing the endpoint time to recover.

**Why it exists:** Without a circuit breaker, a failing backend causes all SDK instances to retry simultaneously, creating a thundering herd that prevents recovery.

#### State Machine

```
CLOSED ──(failures >= threshold)──► OPEN
  ▲                                    │
  │                              (resetTimeout elapsed)
  │                                    ▼
  └──(probe succeeds)────────── HALF_OPEN
                                       │
                              (probe fails)
                                       │
                                       ▼
                                     OPEN
```

#### Internal State

```
CircuitBreaker
├── state: CircuitState              ('CLOSED' | 'OPEN' | 'HALF_OPEN')
├── consecutiveFailures: number
├── lastFailureTime: number          (epoch ms)
├── halfOpenProbeCount: number
├── failureThreshold: number         (default: 5)
├── resetTimeoutMs: number           (default: 30,000ms)
└── halfOpenMaxProbes: number        (default: 1)
```

#### Full Lifecycle

```
1. INITIALIZATION
   new CircuitBreaker({ failureThreshold=5, resetTimeoutMs=30000 })
   → state = 'CLOSED'
   → consecutiveFailures = 0

2. REQUEST GATE (canExecute)
   CLOSED → return true
   OPEN   → if Date.now() - lastFailureTime >= resetTimeoutMs
              → transitionTo('HALF_OPEN') → halfOpenProbeCount = 0 → return true
            else → return false (fast-fail)
   HALF_OPEN → if halfOpenProbeCount < halfOpenMaxProbes
                 → halfOpenProbeCount++ → return true
               else → return false

3. SUCCESS RECORDING (recordSuccess)
   → consecutiveFailures = 0
   → if HALF_OPEN → transitionTo('CLOSED') → log recovery

4. FAILURE RECORDING (recordFailure)
   → consecutiveFailures++
   → lastFailureTime = Date.now()
   → if HALF_OPEN → transitionTo('OPEN') → log probe failed
   → if CLOSED && consecutiveFailures >= failureThreshold
       → transitionTo('OPEN') → log threshold exceeded

5. AUTO-TRANSITION (getState)
   → if OPEN && timeout elapsed → auto-transition to HALF_OPEN
   → returns current state
```

---

### 1.5 Retry System & RetryBudget

**File:** `src/transport/retry.ts`

#### Feature Overview

The retry system provides exponential backoff with jitter for transient failures. The `RetryBudget` prevents retry storms by capping the total number of concurrent retries across all in-flight operations.

**Why it exists:** Without a retry budget, 50 failing batches × 3 retries each = 150 concurrent retry attempts hammering a struggling backend.

#### RetryBudget Internal State

```
RetryBudget
├── inFlight: number              ← current concurrent retries
├── maxConcurrentRetries: number  ← cap (default: 10)
└── totalExhausted: number        ← diagnostic counter

globalRetryBudget = new RetryBudget(10)  ← singleton shared across all transport
```

#### Retry Algorithm

```
retry(operation, options)
  for attempt = 0 to retries:
    try:
      return await operation()
    catch error:
      if attempt >= retries → throw
      if options.retryable(error) === false → throw
      if budget && !budget.tryAcquire() → throw SDKError('RETRY_BUDGET_EXHAUSTED')

      backoffDelay = backoffWithJitter(baseDelayMs, maxDelayMs, attempt)
      retryAfterDelay = extract from Retry-After header (SDKError.context.retryAfterMs)
      nextRetryDelayMs = max(backoffDelay, retryAfterDelay)

      options.onRetry({ error, attempt, nextRetryDelayMs })
      await sleep(nextRetryDelayMs)
      budget.release()
```

#### Backoff Formula

```
exponential = min(maxDelayMs, baseDelayMs * 2^attempt)
jitter      = random(0, exponential/2)
delay       = exponential/2 + jitter
```

This is "full jitter" — prevents synchronized retry waves across multiple SDK instances.

#### Retryable Conditions

```typescript
function isRetryable(error: Error): boolean {
  if (!(error instanceof SDKError)) return false
  if (error.code === 'NETWORK_ERROR') return true
  const status = error.context.statusCode
  return status === 408 || status === 429 || status >= 500
}
```

- `408 Request Timeout` → retry
- `429 Too Many Requests` → retry (with Retry-After header honored)
- `5xx Server Error` → retry
- `4xx Client Error` (except 408, 429) → do NOT retry (permanent failure)

---

### 1.6 LoadShedder

**File:** `src/transport/load-shedder.ts`

#### Feature Overview

The `LoadShedder` classifies events by telemetry priority and drops them based on the current system pressure level from `AdaptivePressureMonitor`. It is the last line of defense before events enter the queue.

#### Priority Classification

```
P0 (p0_critical) — NEVER drop:
  - uncaughtException, unhandledRejection, OOM errors

P1 (p1_error) — drop last:
  - all other errors with stack traces

P2 (p2_request) — drop early:
  - request events, spans

P3 (p3_low) — drop first:
  - messages, metrics, breadcrumbs
```

#### Shedding Matrix

| Pressure Level | P0 | P1 | P2 | P3 |
|---------------|----|----|----|----|
| `normal` | ✅ | ✅ | ✅ | ✅ |
| `elevated` | ✅ | ✅ | ✅ | ✅ (warning only) |
| `high` | ✅ | ✅ | ✅ | ❌ |
| `critical` | ✅ | ✅ | ❌ | ❌ |

#### Internal State

```
LoadShedder
├── droppedCounts: Record<TelemetryPriority, number>
└── totalShed: number

loadShedder = new LoadShedder()  ← module-level singleton
```

#### Full Lifecycle

```
1. EVENT CLASSIFICATION (classifyEvent)
   event.type === 'error' && mechanism.type === 'uncaughtException' → p0_critical
   event.type === 'error' → p1_error
   event.type === 'request' || 'span' → p2_request
   everything else → p3_low

2. SHED DECISION (shouldShed)
   priority = classifyEvent(event)
   pressureLevel = adaptivePressure.getLevel()
   shed = evaluate(priority, pressureLevel)
   if shed: droppedCounts[priority]++; totalShed++
   if totalShed % 100 === 1: log warning (throttled)
   return shed
```

---

### 1.7 RateLimiter — TokenBucket & SlidingWindow

**File:** `src/transport/rate-limit.ts`

#### Feature Overview

Two rate limiter implementations protect the transport layer from burst storms.

#### TokenBucketRateLimiter

```
State:
  tokens: number          ← current available tokens
  capacity: number        ← max burst size
  refillRate: number      ← tokens/second
  lastRefillTime: number  ← for lazy refill calculation

Algorithm (tryAcquire):
  refill() → elapsed = (now - lastRefillTime) / 1000
           → tokens = min(capacity, tokens + elapsed * refillRate)
           → lastRefillTime = now
  if tokens < 1 → return false (rate limited)
  tokens -= 1 → return true
```

**Used in:** `Batcher` (capacity=10, refillRate=2/s) — allows burst of 10 batch sends, then throttles to 2/second.

#### SlidingWindowRateLimiter

```
State:
  timestamps: number[]    ← ring of request timestamps
  maxRequests: number     ← max within window
  windowMs: number        ← window size

Algorithm (tryAcquire):
  pruneExpired(now) → remove timestamps older than windowMs
  if timestamps.length >= maxRequests → return false
  timestamps.push(now) → return true
```

**Pruning optimization:** Finds first non-expired index and splices in one O(n) operation instead of O(n²) shift loop.

---

### 1.8 ConnectionManager

**File:** `src/transport/connection-manager.ts`

#### Feature Overview

`ConnectionManager` enforces per-route and global HTTP connection limits using semaphores. It prevents any single route from monopolizing all available connections.

#### Internal Architecture

```
ConnectionManager
├── globalSemaphore: Semaphore(maxTotalConnections)
├── routeSemaphores: Map<EnterpriseRoute, Semaphore>
├── routeInUse: Record<EnterpriseRoute, number>
└── totalInUse: number

Semaphore (internal)
├── available: number
└── waiters: Array<() => void>   ← promise-based wait queue
```

#### Connection Acquisition Flow

```
acquire(route)
  1. routeSemaphore.acquire(connectionTimeoutMs)
     → if available > 0: available-- → return true immediately
     → else: push waiter to queue → wait for timeout or release
  2. globalSemaphore.acquire(connectionTimeoutMs)
     → if fails: routeSemaphore.release() → return null
  3. routeInUse[route]++; totalInUse++
  4. return ConnectionLease { route, acquiredAt, release() }

release(healthy)
  → routeInUse[route]--; totalInUse--
  → routeSemaphore.release() → wake next waiter if any
  → globalSemaphore.release()
```

#### Routes and Default Limits

| Route | Purpose |
|-------|---------|
| `errors` | Error events |
| `traces` | Span/trace events |
| `metrics` | Metric events |
| `logs` | Log events |
| `profiles` | CPU profiles |
| `crons` | Cron check-ins |
| `requests` | HTTP request events |
| `replays` | Session replays |

---

### 1.9 Sender

**File:** `src/transport/sender.ts`

#### Feature Overview

The `Sender` is the final step in the transport pipeline. It serializes events into JSON payloads, splits them to respect `maxPayloadBytes`, and POSTs them to the ingestion endpoint with retry.

#### Payload Splitting Algorithm

```
createPayloads(events, apiKey, maxPayloadBytes)
  wrapperOverhead = byteLength({ apiKey, events: [] })
  current = []
  currentBatchBytes = wrapperOverhead

  for each event:
    eventBytes = byteLength(event)
    separatorBytes = current.length > 0 ? 1 : 0  ← JSON comma
    candidateBytes = currentBatchBytes + eventBytes + separatorBytes

    if single event > maxPayloadBytes → throw EVENT_TOO_LARGE
    if current.length > 0 && candidateBytes > maxPayloadBytes:
      payloads.push({ apiKey, events: current })
      current = [event]
      currentBatchBytes = wrapperOverhead + eventBytes
    else:
      current.push(event)
      currentBatchBytes = candidateBytes

  if current.length > 0 → payloads.push(...)
```

**Optimization:** O(n) incremental byte tracking instead of re-serializing the entire growing batch on every event (which was O(n²)).

#### Send Flow

```
sendEvents(events)
  for each payload in createPayloads(events):
    await retry(
      () => postJson(config.ingestUrl, payload, {}, timeoutMs, { compression }),
      { retries: config.maxRetries, retryable: isRetryable, budget: globalRetryBudget }
    )
```

---

### 1.10 TransportRouter

**File:** `src/transport/transport-router.ts`

#### Feature Overview

`TransportRouter` is the unified transport singleton. It routes events to per-route `BatchManager` instances, manages the `ConnectionManager`, and handles config hot-swap.

#### Internal Architecture

```
TransportRouter (singleton)
├── batchManagers: Map<EnterpriseRoute, BatchManager>
├── connectionManager: ConnectionManager
├── routeRegistry: RouteRegistry
├── disabled: boolean
└── config: TransportRemoteConfig

Routes: errors | traces | metrics | logs | profiles | crons | requests | replays
```

#### Initialization Flow

```
TransportRouter.initialize(config, apiKey, ingestUrl)
  → if existing instance: await instance.shutdown()
  → createQueuesAndBatchers()
      → for each route: new BatchManager({ route, sender, maxBatchSize, ... })
  → createConnectionManager(config)
  → instance = new TransportRouter(...)
```

#### Event Routing

```
send(event)
  → if disabled → return false
  → route = routeRegistry.resolve(event)
  → batchManager = batchManagers.get(route)
  → batchManager.enqueue(event) → return true/false
```

#### Config Hot-Swap

```
handleConfigChange(diff, newConfig)
  → update batch sizes, timeouts, concurrency per route
  → no restart required — BatchManager reads new config on next pump()
```

---

---

## 2. TRACING

The tracing subsystem is built entirely on OpenTelemetry. The SDK wraps OTel's `NodeTracerProvider` with a custom `PipelineSpanExporter` that routes finished spans through the SDK's own event pipeline rather than directly to an OTLP endpoint.

---

### 2.1 Tracer & PipelineSpanExporter

**File:** `src/tracing/tracer.ts`

#### Feature Overview

`initTracer()` sets up the OTel tracing pipeline. `PipelineSpanExporter` is the bridge between OTel's span lifecycle and the SDK's event pipeline.

**Why it exists:** OTel provides the instrumentation standard. The SDK needs to route spans through its own pipeline (sampling, PII scrubbing, batching, persistence) rather than sending raw OTLP.

#### Initialization Flow

```
initTracer(config, customResources)
  1. Detect OTel resources (host, container, cloud, process)
  2. Create RemoteConfigSampler (FNV-1a deterministic)
  3. Wrap with ParentBasedSampler (propagates root decision to children)
  4. Create NodeTracerProvider:
       sampler: ParentBased(RemoteConfigSampler)
       resource: detected + custom
       contextManager: AsyncLocalStorageContextManager
       propagators: W3CTraceContextPropagator + W3CBaggagePropagator
  5. Add BatchSpanProcessor(PipelineSpanExporter):
       maxQueueSize: 2048
       scheduledDelayMillis: 5000
       exportTimeoutMillis: 30000
       maxExportBatchSize: 512
  6. provider.register() → sets as global OTel tracer
```

#### PipelineSpanExporter

```
PipelineSpanExporter implements SpanExporter

export(spans: ReadableSpan[], resultCallback)
  for each span:
    event = spanToEvent(span)
    → apply privacy.capture.* gates (headers, body, query, cookies)
    → apply limits.maxSpanAttributes
    → compute exclusive duration (span duration - sum of child durations)
    → if !sampled && !hasError → skip (tail-sampling: keep error spans)
    → processEvent(event)  ← routes through SDK event pipeline
  resultCallback({ code: SUCCESS })

spanToEvent(span) → SDKEvent
  → traceId, spanId, parentSpanId from span.spanContext()
  → startTime, endTime, duration from hrTime
  → attributes from span.attributes (OTel semantic conventions)
  → events from span.events (span.addEvent() calls)
  → status from span.status
  → kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer'
```

#### Key Design: Tail Sampling for Errors

```
// Even non-sampled spans are RECORDED (not dropped) by RemoteConfigSampler
// PipelineSpanExporter promotes error-bearing spans to exported:
if (!sampled && span.status.code === SpanStatusCode.ERROR) {
  // Export anyway — error spans always captured regardless of sample rate
}
```

#### Public API

| Function | Description |
|----------|-------------|
| `startSpan(name, options)` | Create a new span (not active in context) |
| `withSpan(name, fn, options)` | Create span, run async fn, auto-end |
| `withSpanSync(name, fn, options)` | Synchronous version of withSpan |
| `getActiveSpan()` | Get current active span from AsyncLocalStorage |
| `shutdownTracer()` | Flush + shutdown TracerProvider |
| `flushTracer()` | Force-flush BatchSpanProcessor |

#### Async Boundary: withSpan

```
withSpan(name, fn, options)
  → tracer.startActiveSpan(name, otelOptions, async (otelSpan) => {
      pulseSpan = new PulseSpan(otelSpan)
      try:
        result = await fn(pulseSpan)
        if !span.isEnded: span.end()
        return result
      catch error:
        span.recordError(error)
        span.setStatus(ERROR)
        if !span.isEnded: span.end()
        throw error
    })
```

The `AsyncLocalStorageContextManager` ensures the span is active in the async context for the entire duration of `fn`, including across `await` boundaries.

---

### 2.2 PulseSpan

**File:** `src/tracing/span.ts`

#### Feature Overview

`PulseSpan` is a thin wrapper around OTel's `Span` interface. It provides a Pulse-specific API while delegating all operations to the underlying OTel span.

#### Internal Architecture

```
PulseSpan
├── otelSpan: OTelSpan          ← underlying OTel span
├── _isEnded: boolean           ← local end tracking
└── spanContext(): SpanContext  ← traceId, spanId, traceFlags
```

#### Key Methods

| Method | Behavior |
|--------|----------|
| `setAttribute(key, value)` | Delegates to `otelSpan.setAttribute()` |
| `recordError(error, attrs)` | Sets status=ERROR, records exception event |
| `recordException(exception)` | OTel-standard exception recording |
| `end(endTime?)` | Ends span, sets `_isEnded = true` |
| `getOTelSpan()` | Returns underlying OTel span for advanced use |

#### Error Recording Flow

```
recordError(error, attributes)
  → otelSpan.recordException(error)
  → otelSpan.setStatus({ code: ERROR, message: error.message })
  → if attributes: otelSpan.setAttributes(attributes)
  → return this (chainable)
```

---

### 2.3 Context Propagation (W3C)

**File:** `src/tracing/context-propagation.ts`

#### Feature Overview

Implements W3C TraceContext propagation for distributed tracing across service boundaries. Uses OTel's native propagation APIs rather than manual header parsing.

#### Headers Managed

| Header | Standard | Purpose |
|--------|----------|---------|
| `traceparent` | W3C | `version-traceId-spanId-flags` |
| `tracestate` | W3C | Vendor-specific trace state |
| `x-pulse-trace-id` | Pulse custom | Non-OTel consumer compatibility |
| `x-pulse-span-id` | Pulse custom | Non-OTel consumer compatibility |
| `x-pulse-sampled` | Pulse custom | `1` or `0` |

#### Extract Flow (Incoming Requests)

```
extractTraceContext(headers)
  → propagation.extract(otelContext.active(), headers, headerGetter)
  → headerGetter.get() handles case-insensitive lookup + array values
  → returns OTel Context with SpanContext embedded
  → AsyncLocalStorageContextManager stores it for the request lifetime
```

#### Inject Flow (Outgoing Requests)

```
injectTraceContext(headers, ctx?)
  → activeCtx = ctx ?? otelContext.active()
  → if TRACING_DEFAULTS.propagation.w3c:
      propagation.inject(activeCtx, headers, headerSetter)
      → adds traceparent + tracestate
  → spanContext = trace.getSpanContext(activeCtx)
  → if spanContext:
      headers['x-pulse-trace-id'] = spanContext.traceId
      headers['x-pulse-span-id'] = spanContext.spanId
      headers['x-pulse-sampled'] = sampled ? '1' : '0'
```

---

### 2.4 RemoteConfigSampler

**File:** `src/tracing/remote-config-sampler.ts`

#### Feature Overview

Custom OTel `Sampler` that delegates sampling decisions to `SamplingEngine`. Replaces the default `TraceIdRatioBasedSampler` with deterministic FNV-1a hash-based sampling.

#### Sampling Decision Flow

```
shouldSample(context, traceId, spanName, spanKind, attributes, links)
  → samplingEngine = SamplingEngine.getInstance()
  → if !samplingEngine → RECORD_AND_SAMPLED (fallback: sample everything)
  → url = attributes['http.route'] ?? attributes['http.target'] ?? attributes['http.url'] ?? ''
  → decision = samplingEngine.shouldSampleTrace(traceId, url)
  → if decision.sampled → RECORD_AND_SAMPLED
  → else → RECORD (not NOT_RECORD — keeps span in memory for error promotion)
```

**Key insight:** `RECORD` (not `NOT_RECORD`) means non-sampled spans are still created in memory. `PipelineSpanExporter` can then promote error-bearing spans to exported even when not sampled — this is the SDK's tail-sampling strategy.

---

### 2.5 SamplingEngine

**File:** `src/core/sampling-engine.ts`

#### Feature Overview

`SamplingEngine` provides deterministic, FNV-1a hash-based sampling decisions. It replaces `Math.random()` with a hash function so the same traceId always produces the same sampling decision across all SDK instances.

#### Internal Architecture

```
SamplingEngine (singleton)
├── config: SamplingConfig
│   ├── traces: number      (0.0–1.0)
│   ├── requests: number
│   ├── errors: number
│   ├── profiles: number
│   ├── replays: number
│   └── routes: Record<string, RouteSamplingRates>
└── destroyed: boolean
```

#### FNV-1a 32-bit Hash

```typescript
static fnv1a32(input: string): number {
  let hash = 0x811c9dc5  // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)  // FNV prime
  }
  return hash >>> 0  // unsigned 32-bit
}
```

Normalized to [0.0, 1.0) by dividing by `2^32 = 0x100000000`.

#### Decision Algorithm

```
decide(id, eventType, route?)
  1. Per-route override (longest prefix match):
     findRouteRates(route) → iterate config.routes
     → find longest pattern where route.startsWith(pattern)
     → if found && routeRates[eventType] defined → evaluate(id, routeRate, 'route_override')

  2. Global rate fallback:
     rate = config[eventType]
     evaluate(id, rate, 'global_rate')

evaluate(id, rate, reason)
  if rate <= 0 → { sampled: false, reason: 'always_drop' }
  if rate >= 1 → { sampled: true, reason: 'always_sample' }
  hash = fnv1a32(id)
  normalized = hash / 0x100000000
  return { sampled: normalized < rate, rate, reason }
```

#### Config Hot-Swap

```
handleConfigChange(diff, newConfig)
  → if destroyed → return
  → if any rate changed → log update
  → this.config = { ...newConfig.sampling }
  → next sampling decision uses new rates immediately
```

---

---

## 3. METRICS

The metrics subsystem is fully OTel-native. All aggregation is delegated to the OTel `MeterProvider` with `ExponentialHistogramAggregation`. The SDK does not compute percentiles — the backend receives raw histogram buckets and computes them server-side.

---

### 3.1 MetricsRegistry

**File:** `src/metrics/registry.ts`

#### Feature Overview

`MetricsRegistry` is the public facade for recording metrics. It enforces cardinality limits via `CardinalityGovernor` and delegates all aggregation to the OTel `MeterProvider`.

**Why it exists:** Provides a stable, backward-compatible API while the underlying aggregation engine can be swapped (was custom percentile computation, now OTel ExponentialHistogram).

#### Internal Architecture

```
MetricsRegistry (singleton: metricsRegistry)
├── maxMetrics: number                    (default: 500)
├── defaultMaxCardinality: number         (default: 1000)
├── initialized: boolean
├── registeredMetrics: Set<string>        ← bounded instrument registry
├── totalFlushed: number
└── totalDropped: number
```

#### Metric Recording Flow

```
recordHistogram(name, value, options)
  → if !initialized → return
  → if !canRegisterMetric(name) → totalDropped++ → return
      (canRegisterMetric: checks Set size < maxMetrics)
  → labels = options.labels ?? {}
  → sanitized = cardinalityGovernor.sanitizeAttributes(name, labels)
      → removes blocked attributes (userId, traceId, etc.)
      → normalizes route paths (/users/123 → /users/:id)
  → seriesKey = serializeLabels(sanitized)
  → if !cardinalityGovernor.canRecordSeries(name, seriesKey) → drop
  → otelMetrics.recordHistogram(name, value, sanitized)
  → totalFlushed++
```

Same pattern for `incrementCounter`, `addUpDownCounter`, `setGauge`.

#### Flush Flow

```
flush()
  → if otelMetrics.isInitialized():
      await otelMetrics.flush()
      → triggers PulseMetricReader.collect()
      → collected metrics → processEvent() → TransportRouter
```

---

### 3.2 OTel Adapter

**File:** `src/metrics/otel-adapter.ts`

#### Feature Overview

`OtelMetricsManager` wraps the OTel `MeterProvider` and configures `ExponentialHistogramAggregation` for all histogram instruments.

#### Key Configuration

```
MeterProvider({
  views: [
    new View({
      instrumentType: InstrumentType.HISTOGRAM,
      aggregation: new ExponentialHistogramAggregation(
        maxSize: 160,    ← max buckets per histogram
        recordMinMax: true
      )
    })
  ],
  readers: [pulseMetricReader]
})
```

**Why ExponentialHistogram:** O(1) per-record bucket increment vs O(n log n) sort-based percentile computation. Buckets are exponentially spaced so they cover many orders of magnitude with fixed memory.

#### PulseMetricReader

```
PulseMetricReader extends MetricReader
  onCollect() → called by MeterProvider.forceFlush()
    → for each metric in collected data:
        → convert to SDK event format
        → processEvent(metricEvent)
        → routes through event pipeline → TransportRouter
```

---

### 3.3 CardinalityGovernor

**File:** `src/utils/cardinality-governor.ts`

#### Feature Overview

Prevents metric cardinality explosion — the #1 cause of metric ingestion rejection at enterprise observability platforms (Datadog, New Relic impose hard limits server-side).

#### Protection Mechanisms

1. **Blocked attributes:** `userId`, `requestId`, `traceId`, `sessionId`, `email`, `ip`, etc. — always removed from metric labels
2. **Route normalization:** `/users/123` → `/users/:id`, UUIDs → `:id`, MongoDB ObjectIds → `:id`
3. **Dimension limit:** Max 10 attribute keys per metric instrument
4. **Series limit:** Max 1000 unique timeseries per instrument
5. **Total series limit:** Max 5000 across all instruments

#### Route Normalization Patterns

```
UUID_PATTERN:    /[0-9a-f]{8}-[0-9a-f]{4}-...-[0-9a-f]{12}/gi → :id
NUMERIC_SEGMENT: /^[0-9]+$/                                    → :id
MONGO_ID:        /^[0-9a-f]{24}$/i                             → :id
HEX_LONG:        /^[0-9a-f]{9,}$/i                             → :id
```

#### Series Tracking

```
seriesTracker: Map<instrumentName, Set<serializedLabels>>
totalSeries: number

canRecordSeries(metricName, attributeKey)
  → if totalSeries >= maxTotalSeries → drop
  → instrumentSeries = seriesTracker.get(metricName) ?? new Set()
  → if instrumentSeries.has(attributeKey) → true (already tracked)
  → if instrumentSeries.size >= maxSeriesPerMetric → drop
  → instrumentSeries.add(attributeKey); totalSeries++
  → return true
```

---

## 4. PROCESSORS

Processors transform events as they flow through the event pipeline. They run in a fixed order: normalize → sanitize → deduplicate → enrich → apply scope.

---

### 4.1 Normalizer

**File:** `src/processors/normalizer.ts`

#### Feature Overview

Ensures all events have required fields with safe defaults. Truncates oversized strings and limits object depth to prevent memory issues.

#### Truncation Limits

| Field | Limit |
|-------|-------|
| String values | 8,192 chars |
| Message fields | 2,048 chars |
| Object depth | 5 levels |
| Array length | 100 items |
| Name fields | 256 chars |

#### Normalization by Event Type

```
normalizeEvent(event, metadata)
  base = { ...event, eventId: event.eventId || generateId(), timestamp: event.timestamp || epochMs() }

  'error':
    → truncate message (2048), name (256)
    → truncateObject(context, depth=5)

  'request':
    → truncate url (8192)
    → method.toUpperCase()

  'message':
    → truncate message (2048)
    → truncateObject(context, depth=5)

  'metric':
    → truncate metricName (256)

  'span':
    → truncate name (256)
    → truncateObject(attributes, depth=5)
    → events.slice(0, 100) → truncate each event name
```

#### Cycle-Safe Object Truncation

```
truncateObject(value, maxDepth, currentDepth=0, seen=new WeakSet())
  if currentDepth >= maxDepth → '[max depth]'
  if typeof string → truncateString(value, 8192)
  if not object → return value
  if seen.has(value) → '[circular]'  ← cycle guard
  seen.add(value)
  if Array → slice(0, 100) + map recursively
  if Object → iterate entries, skip __proto__/constructor/prototype
```

---

### 4.2 Sanitizer (PII Scrubber)

**File:** `src/processors/sanitizer.ts`

#### Feature Overview

`ApiPayloadScrubber` provides enterprise-grade PII and sensitive data redaction. It operates at two levels: explicit API payload governance (headers, bodies) and deep recursive object scrubbing.

#### PII Detection Patterns

| Pattern | Replacement |
|---------|-------------|
| Email addresses | `[email]` |
| Credit card numbers | `[card]` |
| SSN (`XXX-XX-XXXX`) | `[ssn]` |
| Phone numbers | `[phone]` |
| Bearer tokens | `Bearer [REDACTED]` |
| `key=value` in query strings | `key=[REDACTED]` |

#### Sensitive Key Detection

```
DEFAULT_SENSITIVE_KEYS_PATTERN = /(?:password|passwd|secret|token|api[-_]?key|
  api[-_]?secret|authorization|cookie|session[-_]?id|credential|
  private[-_]?key|access[-_]?token|refresh[-_]?token|x-api-key|x-auth-token)/i
```

#### Sanitization Flow

```
sanitizeEvent(event)
  1. Explicit API Payload Governance:
     if event.type === 'request':
       scrubRequestEvent() → sanitizeHeaders(event.headers)
       if redactRequestBody: event.body = '[REDACTED]'
     if event.type === 'span':
       scrubSpanEvent() → redact http.request.header.* / http.response.header.*
       if redactRequestBody: attrs['http.request.body'] = '[REDACTED]'

  2. Deep Object Scrubbing:
     sanitizeValue(event, depth=0)
     → recursive traversal with WeakSet cycle guard
     → MAX_SANITIZE_DEPTH = 10, MAX_OBJECT_KEYS = 200
     → isSensitiveKey(key) → REDACTED
     → sanitizeString(value) → apply PII patterns
```

---

### 4.3 ErrorDeduplicator

**File:** `src/processors/deduplicator.ts`

#### Feature Overview

Suppresses duplicate errors within a configurable time window. Uses an LRU cache keyed by error fingerprint to track seen errors.

**Why it exists:** A tight loop throwing the same error would generate thousands of identical events per second, overwhelming the ingestion pipeline and making dashboards unreadable.

#### Internal Architecture

```
ErrorDeduplicator (singleton: errorDeduplicator)
├── entries: LRUCache<string, DedupEntry>   (capacity: 5000)
│   └── DedupEntry: { firstSeen, lastSeen, count }
├── replaySeen: LRUCache<string, number>    (capacity: 1000)
├── suppressionWindowMs: number             (default: 60,000ms)
├── maxEntries: number                      (default: 5000)
├── cleanupTimer: setInterval               (every 5 minutes)
└── suppressedCount: number

LRUCache (internal)
  → Map with insertion-order eviction
  → get() moves entry to back (LRU promotion)
  → set() evicts oldest if at capacity
```

#### Deduplication Flow

```
isDuplicate(fingerprint)
  now = epochMs()
  existing = entries.get(fingerprint)  ← LRU promotion

  if !existing:
    entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 })
    return false  ← first occurrence, allow through

  if now - existing.lastSeen > suppressionWindowMs:
    entries.set(fingerprint, { firstSeen: now, lastSeen: now, count: 1 })
    return false  ← window expired, treat as new

  existing.lastSeen = now
  existing.count++
  suppressedCount++
  return true  ← duplicate, suppress
```

#### Cleanup Timer

```
setInterval(cleanup, 300_000)  ← every 5 minutes
cleanup()
  for each [fp, entry] in entries:
    if now - entry.lastSeen > suppressionWindowMs:
      entries.delete(fp)
```

Timer is `unref()`'d — does not prevent process exit.

---

---

## 5. CORE ENGINE

The core engine orchestrates SDK initialization, configuration management, feature control, and the central event pipeline.

---

### 5.1 ConfigManager

**File:** `src/core/config-manager.ts`

#### Feature Overview

`ConfigManager` is the single source of truth for all SDK configuration. It fetches remote config from the backend, merges it with user-provided options, applies safety clamps, and distributes changes to all dependent engines via a listener pattern.

#### State Machine

```
ConfigState enum:
  UNINITIALIZED → INITIALIZING → LIVE → DEGRADED → DESTROYED
```

#### Internal Architecture

```
ConfigManager (singleton via getInstance())
├── state: ConfigState
├── config: Readonly<RemoteConfigResponse>   ← frozen deep copy
├── listeners: Set<ConfigChangeListener>
├── refreshTimer: NodeJS.Timeout | null
├── retryTimer: NodeJS.Timeout | null
└── destroyed: boolean
```

#### Initialization Flow

```
initialize(options: SDKInitOptions)
  state = INITIALIZING
  1. fetchConfig() → POST /v1/config with apiKey + capabilities
     → timeout: 3000ms
     → on failure: use defaults (degraded mode)
  2. mergeConfigs(remoteConfig, defaults)
  3. applySafetyClamps(merged)
     → clampMax(maxPayloadSize, SAFETY_CEILINGS.maxPayloadSize)
     → clampRange(flushIntervalMs, 1000, 300000)
     → clampProbability(sampling.traces)
     → etc.
  4. buildUserOverrides(options) → user init options override remote
  5. applyUserOverrides(config, overrides)
  6. freezeDeep(config) → Object.freeze recursively
  7. state = LIVE
  8. notify all listeners
```

#### Safety Clamps

Prevents malicious or misconfigured remote config from causing SDK misbehavior:

```
clampMax(value, ceiling)    → min(value, ceiling)
clampRange(value, floor, ceiling) → max(floor, min(ceiling, value))
clampProbability(value)     → max(0, min(1, value))
```

#### Config Refresh Loop

```
startRefreshLoop()
  → setInterval(refreshConfig, config.refreshIntervalMs ?? 300_000)
  → timer.unref()

refreshConfig()
  → fetchConfig()
  → diff = configDiffer.diff(oldConfig, newConfig)
  → if diff.hasChanges:
      config = freezeDeep(newConfig)
      for each listener: listener(diff, newConfig)
        → KillswitchEngine.handleConfigChange()
        → SamplingEngine.handleConfigChange()
        → FeatureController.handleConfigChange()
        → LimitsEngine.handleConfigChange()
        → TransportRouter.handleConfigChange()
        → SecurityScrubber.handleConfigChange()
```

#### Listener Registration

```
onConfigChange(listener) → () => void (unsubscribe function)
  → listeners.add(listener)
  → return () => listeners.delete(listener)
```

---

### 5.2 KillswitchEngine

**File:** `src/core/killswitch-engine.ts`

#### Feature Overview

`KillswitchEngine` provides reactive feature toggles. Each killswitch maps to a subsystem's shutdown/startup function pair. When a killswitch flips via config refresh, the engine reacts within one config refresh cycle (default 300s, configurable).

#### Killswitch Semantics

| Killswitch | Effect |
|------------|--------|
| `disableSDK` | All public methods become no-ops. Zero data capture, zero network. |
| `disableTracing` | Shut down TracerProvider, flush existing spans, destroy exporter. |
| `disableMetrics` | Stop metric reader loop, flush, stop collection. |
| `disableErrors` | Detach uncaughtException/unhandledRejection listeners. |
| `disableLogs` | Stop console interception, drain buffer. |
| `disableProfiling` | Stop profiler thread, flush in-flight profiles. |
| `disableTransport` | Stop all HTTP outbound. Events queued locally. Auto-resumes on flip. |

#### Internal Architecture

```
KillswitchEngine (singleton)
├── currentState: KillswitchesConfig     ← current killswitch values
├── handlers: Map<killswitch, { shutdown, startup }>
├── sdkDisabled: boolean                 ← fast path for isSDKDisabled()
└── destroyed: boolean
```

#### Config Change Handling

```
handleConfigChange(diff, newConfig)
  for each killswitch key:
    wasActive = oldState[key]
    isActive = newConfig.killswitches[key]

    if wasActive === isActive → skip (no change)

    if !wasActive && isActive:
      → log ACTIVATED
      → await handlers.get(key).shutdown()

    if wasActive && !isActive:
      → log DEACTIVATED
      → await handlers.get(key).startup()

  currentState = { ...newConfig.killswitches }
  sdkDisabled = newConfig.killswitches.disableSDK
```

#### Subsystem Registration

```
registerSubsystem(killswitch, { shutdown, startup })
  handlers.set(killswitch, { shutdown, startup })
  if currentState[killswitch]:
    → immediately call shutdown() (killswitch already active)
```

---

### 5.3 FeatureController

**File:** `src/core/feature-controller.ts`

#### Feature Overview

`FeatureController` controls subsystem instantiation based on `features.*` config. If a feature is `false`, the subsystem class is **never instantiated** — saving CPU and memory, not just "disabling" it.

#### Degraded Mode

When `setDegradedMode(true)` is called (triggered by version policy), only `errors` and `logging` subsystems are allowed. All others are treated as disabled regardless of remote config.

#### Internal Architecture

```
FeatureController (singleton)
├── currentFeatures: FeaturesConfig
├── subsystems: Map<feature, SubsystemRegistration>
│   └── SubsystemRegistration: { feature, factory, teardown, alive }
├── degradedMode: boolean
└── destroyed: boolean
```

#### Subsystem Registration Flow

```
register(feature, factory, teardown)
  registration = { feature, factory, teardown, alive: false }
  subsystems.set(feature, registration)

  if isEnabled(feature):
    await factory()
    registration.alive = true
    log 'Started subsystem: feature'
  else:
    log 'Skipping subsystem (disabled): feature'
```

#### Config Change Handling

```
handleConfigChange(diff, newConfig)
  for each [feature, registration] in subsystems:
    wasEnabled = oldFeatures[feature]
    isEnabled = degradedMode ? (feature === 'errors' || 'logging') : newFeatures[feature]

    if !wasEnabled && isEnabled && !registration.alive:
      await registration.factory()
      registration.alive = true

    if wasEnabled && !isEnabled && registration.alive:
      await registration.teardown()
      registration.alive = false

  currentFeatures = { ...newFeatures }
```

---

### 5.4 LimitsEngine

**File:** `src/core/limits-engine.ts`

#### Feature Overview

`LimitsEngine` enforces payload and attribute limits from remote config. It prevents oversized events from reaching the transport layer.

#### Limits Enforced

| Limit | Description |
|-------|-------------|
| `maxPayloadSize` | Max serialized payload bytes before transport |
| `maxSpanAttributes` | Max attribute count on spans/events |
| `maxAttributeLength` | Max string length for attribute values (truncated with `…`) |
| `maxSpansPerTrace` | Max spans allowed in a single trace |

#### Attribute Enforcement Flow

```
enforceAttributeLimits(event)
  clone = { ...event }

  if 'attributes' in clone:
    clone.attributes = trimAttributes(clone.attributes, maxSpanAttributes, maxAttributeLength)

  if 'context' in clone:
    clone.context = trimAttributes(clone.context, maxSpanAttributes, maxAttributeLength)

  if 'tags' in clone:
    clone.tags = trimAttributes(clone.tags, maxSpanAttributes, maxAttributeLength)

  return clone  ← never mutates original

trimAttributes(attrs, maxCount, maxLength)
  result = {}
  count = 0
  for each [key, value] in attrs:
    if count >= maxCount → log warning → break
    result[key] = truncateValue(value, maxLength)
    count++
  return result

truncateValue(value, maxLength)
  if typeof string && length > maxLength:
    return value.slice(0, maxLength) + '…'
  return value
```

---

### 5.5 Event Pipeline

**File:** `src/core/event-pipeline.ts`

#### Feature Overview

The event pipeline is the central processing hub for all SDK events. It accepts events from capture APIs, processes them through a chain of transformations, and routes them to the transport layer.

#### Full Pipeline Execution (25 Steps)

```
SYNCHRONOUS PHASE (enqueueEvent — returns EventReceipt immediately):
  1.  Validate options (Zod schema)
  2.  Generate eventId + timestamp
  3.  Check client.shutdown flag → reject if true
  4.  Check pipelineDraining flag → reject if true
  5.  Check KillswitchEngine.isSDKDisabled() → reject if true
  6.  Check LimitsEngine.admitEvent() → reject if rate-limited
  7.  Check isCriticalMemoryPressure() → reject low-priority if critical
  8.  Check loadShedder.shouldShed() → reject if overloaded
  9.  If !client.initialized → buffer to pre-init eventQueue (sync)
  10. If initialized → create Promise + setImmediate (async handoff)

ASYNCHRONOUS PHASE (processEventAsync — runs in next event loop tick):
  11. Re-check killswitch (may have changed)
  12. ensureBaseFields() → assign eventId, timestamp, metadata
  13. Check feature flags (enableErrors, enableTracing, etc.)
  14. LimitsEngine.enforceAttributeLimits()
  15. normalizeEvent() → fill defaults, truncate oversized fields
  16. enrichFromContext() → attach traceId, spanId, breadcrumbs, sessionId
  17. errorDeduplicator.isDuplicate() → drop if duplicate within window
  18. applyScopeToEvent() → attach user, tags, extra, context from Scope
  19. attachSourceContext() (errors only) → source map resolution
  20. Plugin.processEvent() (each registered plugin, sequential)
  21. EventProcessor (user-registered processors, sequential)
  22. beforeSend hook (if plan allows)
  23. Plugin.beforeSend (each plugin)
  24. TransportRouter.send() → route to per-route BatchManager
  25. persistenceGovernor.shouldPersist() → persist if needed
```

#### Async Boundary: setImmediate

```typescript
// Capture returns immediately — processing deferred to next event loop tick
setImmediate(async () => {
  await processEventAsync(rawEvent, assignedEventId)
})
```

**Why `setImmediate` over `Promise.resolve()`:**
- `setImmediate` fires after I/O events in the event loop
- `Promise.resolve()` fires in the microtask queue (before I/O)
- `setImmediate` gives the current request handler time to complete before processing

#### Pre-Init Buffering

```
if (!client.initialized):
  client.eventQueue.push(rawEvent)  ← sync buffer
  // Replayed after init() completes
```

#### Per-Step Timeouts

```
withTimeout(promise, timeoutMs, message)
  → Promise.race([promise, timeout(timeoutMs)])
  → prevents slow plugins/processors from blocking the pipeline
```

---

---

## 6. STORAGE

The storage subsystem provides crash recovery. Events are persisted to disk so they survive process crashes and are replayed on the next SDK initialization.

---

### 6.1 PersistentStorage

**File:** `src/storage/persistent-storage.ts`

#### Feature Overview

`PersistentStorage` writes events to NDJSON (newline-delimited JSON) files on disk. On SDK initialization, it replays any persisted events that were not successfully sent before the previous process exit.

**Why it exists:** Without persistence, events in the in-memory queue are lost on process crash. For errors and critical spans, this is unacceptable.

#### Internal Architecture

```
PersistentStorage (singleton: persistentStorage)
├── directory: string                    (default: .tmp/pulse-sdk/events/)
├── maxFileSizeBytes: number             (default: 10MB)
├── maxFiles: number                     (default: 5)
├── pendingWrites: Event[]               ← in-memory write buffer
├── flushTimer: NodeJS.Timeout | null    ← scheduled flush
├── writeQueue: Promise<void>            ← serialized write operations
├── stats: { persisted, discarded, replayed, errors }
└── initialized: boolean
```

#### File Format: NDJSON

```
{"eventId":"abc","type":"error","timestamp":1234567890,...}\n
{"eventId":"def","type":"request","timestamp":1234567891,...}\n
```

Each line is a complete JSON object. This format is:
- Appendable without reading the entire file
- Recoverable even if the last line is truncated (partial write on crash)
- Streamable for large files

#### Full Lifecycle

```
1. INITIALIZATION (init)
   → ensureDirectory() → mkdir -p
   → checkAndRotate() → if file > maxFileSizeBytes → rotate
   → replay() → read all NDJSON lines → parse → return Event[]
   → replayed events re-enter the event pipeline

2. PERSIST (persist — synchronous enqueue)
   persist(event)
   → pendingWrites.push(event)
   → scheduleFlush() → setTimeout(0) if not already scheduled

3. FLUSH (flush — async write)
   flush()
   → enqueueWrite(async () => {
       lines = pendingWrites.map(JSON.stringify).join('\n') + '\n'
       pendingWrites = []
       await fs.appendFile(filePath, lines)
     })
   → enqueueWrite serializes writes: each write awaits previous

4. DISCARD (discard — remove sent events)
   discard(events)
   → read current file
   → filter out events with matching eventIds
   → rewriteFile(remaining)

5. REPLAY (replay — on init)
   → read file line by line
   → JSON.parse each line
   → filter out malformed lines
   → return valid Event[]

6. ROTATION (checkAndRotate)
   → if file size > maxFileSizeBytes:
       rotate() → rename current → .bak
       → if .bak files > maxFiles → delete oldest

7. SHUTDOWN (shutdown)
   → flush() → write all pending
   → await writeQueue (drain in-flight writes)
```

#### Write Serialization

```
enqueueWrite(operation)
  writeQueue = writeQueue.then(operation).catch(handleError)
  → all writes are chained — never concurrent
  → prevents file corruption from parallel writes
```

#### I/O Timeout Protection

```
withIoTimeout(promise, timeoutMs=5000, label)
  → Promise.race([promise, timeout(timeoutMs)])
  → prevents disk I/O from blocking shutdown indefinitely
```

---

### 6.2 PersistenceGovernor

**File:** `src/storage/persistence-governor.ts`

#### Feature Overview

`PersistenceGovernor` decides which events should be persisted to disk. It applies a priority matrix based on event durability tier and current system pressure, with a per-minute budget to prevent runaway disk I/O.

#### Durability Tiers

| Tier | Event Types | Description |
|------|-------------|-------------|
| `critical` | `error` | Must survive crashes — always persist |
| `important` | `request`, `span` | Valuable for debugging — persist under normal/elevated pressure |
| `transient` | `metric`, `message`, others | Easily re-emitted — persist only under normal pressure |

#### Pressure Matrix

```
┌──────────────┬─────────┬──────────┬──────────┬──────────┐
│ Tier         │ Normal  │ Elevated │ High     │ Critical │
├──────────────┼─────────┼──────────┼──────────┼──────────┤
│ critical     │ ✅       │ ✅        │ ✅        │ ✅        │
│ important    │ ✅       │ ✅        │ 50%*     │ ❌        │
│ transient    │ ✅       │ 50%*     │ ❌        │ ❌        │
└──────────────┴─────────┴──────────┴──────────┴──────────┘
* 50% = deterministic hash-based sampling (same eventId → same decision)
```

#### Deterministic 50% Sampling

```
deterministicSample(event, rate=0.5)
  id = event.eventId ?? ''
  hash = 0
  for each char in id:
    hash = (hash * 31 + charCode) | 0
  return (Math.abs(hash) % 100) < (rate * 100)
```

Same eventId always gets the same persist/skip decision — prevents non-deterministic replay behavior across restarts.

#### Per-Minute Budget

```
PersistenceGovernor
├── maxPersistPerMinute: number          (default: 5000)
├── persistWindows: Array<{timestamp}>  ← sliding window
└── windowDurationMs: 60_000

isOverBudget()
  → prune entries older than 60s
  → return persistWindows.length >= maxPersistPerMinute

recordPersist()
  → persistWindows.push({ timestamp: epochMs() })
```

---

## 7. SESSION

---

### 7.1 SessionManager

**File:** `src/session/session-manager.ts`

#### Feature Overview

`SessionManager` tracks user sessions for telemetry correlation. It provides session IDs for event enrichment, tracks crash-free session rates, and handles session expiry.

#### Session Lifecycle

```
start → active (events increment counter) → idle timeout → ended
                                          → max duration → ended
                                          → error occurred → marked as crashed
```

#### Internal Architecture

```
SessionManager (singleton via getSessionManager())
├── currentSession: Session | null
│   └── Session: { id, startedAt, lastActivityAt, eventCount, errorCount, crashed, status }
├── idleTimeoutMs: number              (default: 30 minutes)
├── maxDurationMs: number              (default: 4 hours)
├── totalSessions: number              ← for crash-free rate
└── crashedSessions: number

Session expiry conditions:
  - now - lastActivityAt > idleTimeoutMs  (idle)
  - now - startedAt > maxDurationMs       (max duration)
  - session.status === 'ended'            (explicit end)
```

#### Session Flow

```
getSession()
  → if currentSession && isExpired() → endSession('expired')
  → if !currentSession:
      currentSession = createSession(now)
      totalSessions++
  → return currentSession

recordActivity()
  → session = getSession()
  → session.lastActivityAt = epochMs()
  → session.eventCount++

recordError()
  → session = getSession()
  → session.errorCount++
  → if !session.crashed:
      session.crashed = true
      crashedSessions++

getCrashFreeRate()
  → if totalSessions === 0 → 1.0
  → (totalSessions - crashedSessions) / totalSessions
```

#### Singleton Management

```
getSessionManager(options?) → SessionManager
  → creates singleton on first call
  → options honored only on first creation

resetSessionManager()
  → sessionManager.endSession('shutdown')
  → sessionManager = null
  → next getSessionManager() creates fresh instance
```

---

## 8. UTILITIES

---

### 8.1 AdaptivePressureMonitor

**File:** `src/utils/adaptive-pressure.ts`

#### Feature Overview

`AdaptivePressureMonitor` is the unified runtime protection system. It combines four pressure signals into a single composite score that all subsystems query for adaptive behavior.

#### Pressure Signals

| Signal | Source | Scoring |
|--------|--------|---------|
| Memory pressure | `MemoryPressureMonitor` | normal=0, elevated=40, critical=80 |
| Event loop lag | `EventLoopLagMonitor` (perf_hooks p99) | <50ms=0, <200ms=20, <500ms=45, ≥500ms=75 |
| Queue depth | `getQueueUtilization()` callback | <50%=0, <80%=25, <95%=50, ≥95%=75 |
| GC pressure | `PerformanceObserver` (gc entries) | <10%=0, <30%=25, ≥30%=50 |

#### Composite Score → Level

```
compositeScore = max(memoryScore, lagScore, queueScore, gcScore)
  ← max-of ensures any single critical signal dominates

score < 25  → 'normal'
score < 50  → 'elevated'
score < 75  → 'high'
score >= 75 → 'critical'
```

#### Internal Architecture

```
AdaptivePressureMonitor (singleton: adaptivePressure)
├── memoryMonitor: MemoryPressureMonitor
├── lagMonitor: EventLoopLagMonitor       ← perf_hooks histogram
├── gcObserver: PerformanceObserver | null
├── timer: setInterval(pollIntervalMs=2000)
├── lastLevel: CompositePressureLevel
├── lastSnapshot: PressureSnapshot
└── levelChangeCallbacks: Array<callback>
```

#### Polling Cycle

```
poll() — every 2000ms
  lagStats = lagMonitor.getStats()
  currentLagMs = lagStats.p99 ?? 0

  gcWindowDuration = now - gcWindowStart
  gcPressure = (gcTimeMs / gcWindowDuration) * 100
  if gcWindowDuration > 60_000: reset GC window

  memoryState = memoryMonitor.getState()
  queueUtil = getQueueUtilization()

  compositeScore = max(scoreMemory, scoreLag, scoreQueue, scoreGC)
  level = scoreToLevel(compositeScore)

  if level !== lastLevel:
    lastLevel = level
    log 'Pressure level changed'
    for each callback: callback(snapshot)
```

#### GC Tracking

```
startGCTracking()
  gcObserver = new PerformanceObserver(list => {
    for entry of list.getEntries():
      gcTimeMs += entry.duration  ← accumulate GC time
  })
  gcObserver.observe({ entryTypes: ['gc'] })
```

---

### 8.2 MemoryPressureMonitor (Backpressure)

**File:** `src/utils/backpressure.ts`

#### Feature Overview

`MemoryPressureMonitor` polls `process.memoryUsage()` and emits events when heap utilization crosses thresholds. It is used by both `AdaptivePressureMonitor` and the legacy `Batcher`.

#### Pressure Levels

| Level | Heap Utilization | Behavior |
|-------|-----------------|----------|
| `normal` | < 70% | Accept all events |
| `elevated` | 70–90% | Reject `normal` priority events |
| `critical` | ≥ 90% | Reject `normal` and `high`, only `critical` survives |

#### Small Heap Guard

```
// V8 starts with a tiny heap that grows on demand
// High ratio on small heap does NOT indicate actual pressure
if (heapTotalMb < minHeapTotalMb=100):
  level = 'normal'  ← ignore utilization ratio
```

#### Polling

```
start()
  timer = setInterval(check, pollIntervalMs=5000)
  timer.unref()  ← does not prevent process exit

check()
  state = getState()  ← reads process.memoryUsage()
  if state.level !== lastLevel:
    lastLevel = state.level
    emit('pressure', state)  ← EventEmitter
```

#### Hot-Path Helper

```
getMemoryPressureLevel(): PressureLevel
  → one-shot check without a monitor instance
  → used in event pipeline hot path
  → reads process.memoryUsage() directly (no caching)
```

---

## 9. COMPLETE END-TO-END LIFECYCLE

This section documents the complete lifecycle of a single error event from user code to backend ingestion.

```
USER CODE:
  try { ... } catch (error) { captureError(error, { context: { userId: '123' } }) }

STEP 1 — SYNCHRONOUS ACCEPTANCE (enqueueEvent):
  → Zod validation of options
  → Generate eventId (UUID v4)
  → Check: SDK shutdown? → no
  → Check: KillswitchEngine.isSDKDisabled()? → no
  → Check: LimitsEngine.admitEvent()? → yes (always true now)
  → Check: isCriticalMemoryPressure()? → no (heap < 90%)
  → Check: loadShedder.shouldShed(event)? → no (p1_error, pressure=normal)
  → client.initialized? → yes
  → setImmediate(processEventAsync) ← async handoff
  → return EventReceipt { eventId, status: 'queued' }

STEP 2 — ASYNC PROCESSING (processEventAsync, next event loop tick):
  → Re-check killswitch → ok
  → ensureBaseFields() → eventId, timestamp, metadata
  → isFeatureEnabled('errors')? → yes
  → LimitsEngine.enforceAttributeLimits() → trim context if needed
  → normalizeEvent() → truncate message (2048), name (256), context (depth 5)
  → enrichFromContext():
      → traceId = getTraceId() from AsyncLocalStorage
      → spanId = getSpanId() from AsyncLocalStorage
      → sessionId = sessionManager.getSessionId()
      → breadcrumbs = client.breadcrumbs.toArray()
  → errorDeduplicator.isDuplicate(fingerprint)? → no (first occurrence)
  → applyScopeToEvent() → attach user, tags, extra from current Scope
  → attachSourceContext() → source map resolution for stack frames
  → Plugin.processEvent() → each plugin transforms event
  → EventProcessor (user-registered) → user transforms
  → beforeSend hook → user can modify or drop
  → TransportRouter.send(event):
      → routeRegistry.resolve(event) → 'errors' route
      → batchManagers.get('errors').enqueue(event)
          → buffer.push(event)
          → pump() → if buffer.length >= maxBatchSize → flush
          → ensureTimer() → arm 5s flush timer
  → persistenceGovernor.shouldPersist(event):
      → tier = 'critical' (error type)
      → pressure = 'normal'
      → always persist → persistentStorage.persist(event)
          → pendingWrites.push(event)
          → scheduleFlush() → setTimeout(0)

STEP 3 — BATCH FLUSH (timer fires or batch full):
  BatchManager.pump()
  → nextSerializableBatch() → take up to maxBatchSize events
  → sendBatch(batch):
      → circuitBreaker.canExecute()? → yes (CLOSED)
      → inFlight++
      → sender.sendEvents(batch):
          → createPayloads(batch, apiKey, maxPayloadBytes)
          → for each payload:
              → retry(() => postJson(ingestUrl, payload), { retries: 3 })
                  → attempt 1: POST https://ingest.pulse.io/v1/events
                  → 200 OK → success
          → circuitBreaker.recordSuccess()
          → persistentStorage.discard(batch) → remove from NDJSON file
      → inFlight--

STEP 4 — BACKEND RECEIVES:
  → Payload: { apiKey: "...", events: [{ type: "error", ... }] }
  → 200 OK → event ingested

TOTAL LATENCY IMPACT ON USER REQUEST:
  → Synchronous phase: ~0.1ms (validation + setImmediate scheduling)
  → Async phase: runs after request handler completes
  → Network: background, does not block user response
```

---

## 10. ARCHITECTURAL PATTERNS SUMMARY

| Pattern | Implementation | Purpose |
|---------|---------------|---------|
| Singleton | `getInstance()` on all engines | Single source of truth per process |
| Observer | `onConfigChange(listener)` | Config change propagation without coupling |
| Strategy | `RemoteConfigSampler` implements OTel `Sampler` | Pluggable sampling algorithm |
| Circuit Breaker | `CircuitBreaker` in transport | Prevent cascading failures |
| Token Bucket | `TokenBucketRateLimiter` | Smooth rate limiting with burst |
| Priority Queue | `EventQueue` 3-tier | Ensure critical events survive load |
| Backpressure | `AdaptivePressureMonitor` | Adaptive degradation under load |
| Tail Sampling | `PipelineSpanExporter` error promotion | Capture errors even when not sampled |
| Deterministic Sampling | FNV-1a hash | Consistent decisions across instances |
| Write-Ahead Log | NDJSON `PersistentStorage` | Crash recovery |
| LRU Cache | `ErrorDeduplicator` | Bounded memory for dedup state |
| Semaphore | `ConnectionManager` | Per-route connection limits |
| Single-Flight | `inFlightFlush` in Batcher | Prevent duplicate flush on concurrent shutdown |
| Graceful Degradation | `FeatureController.degradedMode` | Errors-only mode on version mismatch |

---

*Document generated by Kiro — Phase 2 Feature-by-Feature Deep Documentation*
*SDK: sdk-node (Pulse SDK) | Analysis Date: May 2026*
