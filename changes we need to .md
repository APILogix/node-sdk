# Changes We Need

> Enterprise-grade fix list and implementation plan for Pulse SDK v2.0.0
>
> **Generated:** 2026-05-21
> **Auditor:** Principal Observability Architect
> **Scope:** Critical fixes (P0), architecture improvements, OTel migration
> **Status:** Not implemented — for engineering team execution

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Critical Fixes (P0)](#critical-fixes-p0)
3. [High-Priority Fixes (P1)](#high-priority-fixes-p1)
4. [Medium-Priority Fixes (P2)](#medium-priority-fixes-p2)
5. [Architecture Changes](#architecture-changes)
6. [OTel Migration Plan](#otel-migration-plan)
7. [Implementation Phases](#implementation-phases)
8. [Testing Requirements](#testing-requirements)
9. [Rollback Plans](#rollback-plans)
10. [Code Snippets](#code-snippets)

---

## Executive Summary

This document consolidates all critical, high-priority, and medium-priority fixes identified in the comprehensive enterprise audit of the Pulse SDK. **Each fix is documented with its problem, solution, affected files, effort estimate, and code snippet.**

**Total Critical Issues:** 10  
**Total High-Priority Issues:** 8  
**Total Medium-Priority Issues:** 12  

**Estimated Total Effort:** ~3 engineer-weeks for P0s, ~6 weeks total  

**Backwards Compatibility:** All fixes must maintain the existing public API surface. Internal changes only unless explicitly noted.

---

## Critical Fixes (P0)

### P0.1: Fix Graceful Shutdown — Flush Queue Before Exit

**Problem:** `stopBatcher()` does not flush remaining events. SIGTERM or SDK `shutdown()` drops all queued events silently.

**Impact:** Data loss on every deployment, pod restart, or Lambda cold start.

**Affected Files:**
- `src/transport/batcher.ts`
- `src/core/lifecycle.ts`

**Current Code (BROKEN):**
```typescript
// transport/batcher.ts:117-130
export function stopBatcher(): void {
  isRunning = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  inFlightCount = 0
  circuitBreaker.reset()    // ← Dangerous: loses failure history
  rateLimiter.reset()
  logger.debug('Batcher stopped')
}
```

**Required Fix:**
```typescript
// NEW: Add graceful shutdown method
export async function gracefulShutdown(timeoutMs: number = 10_000): Promise<void> {
  isRunning = false
  
  // Stop accepting new ticks but allow in-flight to complete
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  
  // Drain remaining queue with timeout
  const start = Date.now()
  while (eventQueue.size() > 0 && Date.now() - start < timeoutMs) {
    try {
      await flush()
    } catch {
      // Continue trying until timeout
    }
  }
  
  // DO NOT reset circuit breaker — preserve failure history
  logger.debug('Batcher gracefully stopped', {
    remainingEvents: eventQueue.size(),
    inFlight: inFlightCount,
    circuitState: circuitBreaker.getState(),
  })
}
```

**Effort:** 0.5 days  
**Risk:** Low — adds new method, existing `stopBatcher()` unchanged for compatibility.  
**Testing:** Unit test with 100 queued events, verify all flushed before exit.

---

### P0.2: Make Persistent Storage Asynchronous

**Problem:** `appendFileSync` blocks the event loop. At 10K+ RPM, this causes event loop lag and cascading queue overflow.

**Impact:** Request timeouts, queue drops, CPU saturation.

**Affected Files:**
- `src/storage/persistent-storage.ts`
- `src/core/event-pipeline.ts` (caller)

**Current Code (BROKEN):**
```typescript
// persistent-storage.ts:145
const content = entries.join('\n') + '\n'
appendFileSync(this.dataFile, content, { encoding: 'utf8' }) // ← BLOCKS
```

**Required Fix:**
```typescript
import { appendFile, access, mkdir } from 'fs/promises'
import { dirname } from 'path'

// Replace appendFileSync with debounced async batch write
private writeBuffer: string[] = []
private writeTimer: NodeJS.Timeout | null = null

async persist(event: Event): Promise<void> {
  if (!this.initialized) return
  
  this.writeBuffer.push(JSON.stringify({ event, persistedAt: epochMs() }))
  
  this.scheduleWrite()
}

private scheduleWrite(): void {
  if (this.writeTimer) return
  
  this.writeTimer = setTimeout(() => {
    this.flushAsync()
    this.writeTimer = null
  }, 100)  // Debounce 100ms
  
  this.writeTimer.unref()
}

private async flushAsync(): Promise<void> {
  if (this.writeBuffer.length === 0) return
  
  const content = this.writeBuffer.join('\n') + '\n'
  this.writeBuffer = []
  
  try {
    await access(this.dataFile)
  } catch {
    await mkdir(dirname(this.dataFile), { recursive: true })
  }
  
  try {
    await appendFile(this.dataFile, content, { encoding: 'utf8' })
    this.totalPersisted += this.writeBuffer.length
  } catch (error) {
    getLogger().warn('Async persist failed', { error })
  }
}
```

**Alternative (if caller requires sync):** Keep `persist()` signature sync but buffer and flush async internally.

**Effort:** 1 day  
**Risk:** Medium — behavior changes from immediate write to debounced write.  
**Testing:** Mock fs, verify order preserved, verify data survives crash.

---

### P0.3: Fix Histogram Percentile Computation

**Problem:** Linear interpolation between min and max is mathematically incorrect for exponential distributions. p99 is drastically underestimated.

**Impact:** False confidence in low latency during incidents. SLA breaches undetected.

**Affected Files:**
- `src/metrics/otel-adapter.ts`

**Current Code (BROKEN):**
```typescript
// metrics/otel-adapter.ts:228-241
const rank = (p / 100) * (totalCount - 1)
const fraction = rank / (totalCount - 1)
return min + fraction * (max - min)  // ← LINEAR INTERPOLATION: WRONG
```

**Required Fix:**
Replace entirely. Use OTel's built-in histogram bucket counts.

```typescript
import { HistogramAggregation, ExplicitBucketHistogramAggregation } from '@opentelemetry/sdk-metrics'

// INSTRUCTION: In the MeterProvider setup, use standard aggregations
const meterProvider = new MeterProvider({
  resource,
  readers: [this.reader],
  views: [
    {
      instrumentName: '*',
      aggregation: new ExplicitBucketHistogramAggregation([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]),
    },
  ],
})
```

**Simpler Alternative:** Remove custom `computePercentilesFromExponential()` method entirely. Let the backend compute percentiles from raw bucket counts.

**Effort:** 1 day  
**Risk:** Low — removes broken code, shifts computation to backend.  
**Testing:** Generate test data with known p99, verify reported value.

---

### P0.4: Fix Span Context Propagation in `withSpan()`

**Problem:** `withSpan()` creates a span but does not set it as the active span in OTel context. Child spans become siblings instead of children. Trace trees are broken.

**Impact:** Broken distributed traces. Orphan spans. No parent-child relationships.

**Affected Files:**
- `src/tracing/tracer.ts`

**Current Code (BROKEN):**
```typescript
// tracing/tracer.ts:236-256
export async function withSpan<T>(name: string, fn: (span: PulseSpan) => T | Promise<T>, options?: SpanOptions): Promise<T> {
  const span = startSpan(name, options)
  // ← MISSING: otelContext.with(trace.setSpan(...))
```

**Required Fix:**
```typescript
import { context as otelContext, trace } from '@opentelemetry/api'

export async function withSpan<T>(name: string, fn: (span: PulseSpan) => T | Promise<T>, options?: SpanOptions): Promise<T> {
  const span = startSpan(name, options)
  const otelSpan = span.unwrap()  // Get underlying OTel span
  
  // Set span as active in OTel context
  const ctx = trace.setSpan(otelContext.active(), otelSpan)
  
  return otelContext.with(ctx, async () => {
    try {
      const result = await fn(span)
      span.setStatus('ok')
      return result
    } catch (err) {
      if (err instanceof Error) {
        span.recordError(err)
      }
      span.setStatus('error', err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      span.end()
    }
  })
}
```

**Note:** Requires `PulseSpan` to expose `unwrap()` or similar to get the underlying OTel span.

**Effort:** 0.5 days  
**Risk:** Low — internal change, no API break if `startSpan` is updated.  
**Testing:** Nested spans in a test, verify parent-child IDs.

---

### P0.5: Add Memory Pressure Gate to Event Pipeline

**Problem:** `processEvent()` continues to accept and queue events even when memory is critical. The SDK protects the transport (batching) but not the host application.

**Impact:** OOM kills. Process terminated by system.

**Affected Files:**
- `src/core/event-pipeline.ts`
- `src/utils/backpressure.ts` (existing, unused in pipeline)

**Required Fix:**
```typescript
import { MemoryPressureMonitor } from '../utils/backpressure.js'

const memoryMonitor = new MemoryPressureMonitor()

export function processEvent(rawEvent: SDKEvent | Event): boolean {
  const logger = getLogger()
  
  // P0 FIX: Memory pressure gate
  const memState = memoryMonitor.getState()
  if (memState.level === 'critical') {
    logger.warn('Event dropped — critical memory pressure', {
      eventType: rawEvent.type,
      heapUtilization: memState.heapUtilization,
    })
    return false
  }
  
  // ... rest of pipeline
}
```

**Effort:** 0.5 days  
**Risk:** Very Low — adds a check, no behavioral change unless critical.  
**Testing:** Simulate heap pressure (e.g., allocate large buffer), verify events dropped.

---

### P0.6: Prevent Event Loss on Retry Requeue

**Problem:** When `sendEvents()` fails, `requeueFront()` evicts oldest events to make room. Retry events (already failed once) are silently discarded.

**Impact:** Most important events (the ones that failed) are lost first.

**Affected Files:**
- `src/transport/queue.ts`
- `src/transport/batcher.ts`

**Required Fix:**
Implement a priority flag or separate retry queue.

```typescript
// Option A: Priority flag
interface Event {
  // ... existing fields
  priority?: number  // 0 = normal, 1 = retry (higher = more important)
}

// Option B: Separate retry queue (preferred)
class EventQueue {
  private mainQueue: Event[] = []
  private retryQueue: Event[] = []  // Always drained first
  
  add(event: Event, isRetry: boolean = false): void {
    if (isRetry) {
      this.retryQueue.push(event)
    } else {
      this.mainQueue.push(event)
    }
  }
  
  drain(batchSize: number): Event[] {
    // Drain retry queue first, then main queue
    const retries = this.retryQueue.splice(0, batchSize)
    if (retries.length >= batchSize) return retries
    
    const main = this.mainQueue.splice(0, batchSize - retries.length)
    return [...retries, ...main]
  }
}
```

**Effort:** 1 day  
**Risk:** Medium — changes queue semantics.  
**Testing:** Fill queue, simulate retry, verify retry events preserved.

---

### P0.7: Bound Deduplicator Map to Prevent OOM

**Problem:** `ErrorDeduplicator` stores every unique error fingerprint indefinitely. At 1M unique errors/hour, Map grows to ~1GB.

**Impact:** Memory leak → OOM kill.

**Affected Files:**
- `src/processors/deduplicator.ts`

**Required Fix:**
```typescript
// processors/deduplicator.ts
// Replace Map with LRU

class ErrorDeduplicator {
  // Instead of: private entries = new Map<string, DedupEntry>()
  private entries = new LRUMap<string, DedupEntry>(this.maxEntries)
  
  // ...rest of class unchanged except cleanup becomes simpler
}

// Simple LRU implementation
class LRUMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super()
  }
  
  set(key: K, value: V): this {
    if (this.size >= this.maxSize && !this.has(key)) {
      const firstKey = this.keys().next().value
      this.delete(firstKey)
    }
    return super.set(key, value)
  }
}
```

**Effort:** 0.5 days  
**Risk:** Very Low — internal change, no API break.  
**Testing:** Generate 1M entries, verify memory bounded.

---

### P0.8: Prevent Circuit Breaker Reset on Shutdown

**Problem:** `stopBatcher()` calls `circuitBreaker.reset()`, erasing failure history. On restart after backend outage, the SDK hammers the struggling backend.

**Impact:** Backend DDoS during recovery.

**Affected Files:**
- `src/transport/batcher.ts`

**Required Fix:**
Remove the line:
```typescript
// DELETE THIS LINE from stopBatcher():
// circuitBreaker.reset()
```

Add explicit reset method for testing only:
```typescript
/** For testing only. Never call in production. */
export function forceResetCircuitBreaker(): void {
  circuitBreaker.reset()
}
```

**Effort:** 5 minutes  
**Risk:** None — removes dangerous line.  
**Testing:** Simulate failures, verify CB state preserved across restart.

---

### P0.9: Fix AsyncLocalStorage Context Drift in Timers

**Problem:** `addBreadcrumb()` silently fails outside an `AsyncLocalStorage` context (e.g., in `setTimeout`, `EventEmitter`, or worker threads).

**Impact:** Lost breadcrumbs. Broken debugging.

**Affected Files:**
- `src/core/context.ts`

**Required Fix:**
```typescript
// Option A: Log warning
export function addBreadcrumb(input: BreadcrumbInput): void {
  const store = asyncLocalStorage.getStore()
  if (!store) {
    getLogger().debug('addBreadcrumb called outside context — ignored', {
      category: input.category,
      message: input.message,
    })
    return
  }
  // ... rest of function
}

// Option B: Provide helper for non-request contexts
export function runAsyncContext<T>(fn: () => T, overrides?: Partial<ContextStore>): T {
  const store = createContextStore(crypto.randomUUID(), 100, overrides)
  return withContext(store, fn)
}
```

**Effort:** 0.5 days  
**Risk:** Low — adds warning, no break.  
**Testing:** Call `addBreadcrumb()` outside context, verify warning logged.

---

### P0.10: Prevent OTel Double-Initialization

**Problem:** If host application or another library already initializes OTel, the SDK overwrites it. Two `NodeTracerProvider` instances = undefined behavior.

**Impact:** Broken traces. Lost spans. Conflicting context managers.

**Affected Files:**
- `src/tracing/tracer.ts`

**Required Fix:**
```typescript
import { trace } from '@opentelemetry/api'

export function initTracer(config: ResolvedSDKConfig): void {
  if (initialized) return
  
  // P0 FIX: Detect existing OTel provider
  const existingProvider = trace.getTracerProvider()
  if (existingProvider && !(existingProvider instanceof ProxyTracerProvider)) {
    getLogger().warn('OpenTelemetry already initialized — skipping SDK tracer init', {
      existingProviderName: existingProvider.constructor.name,
    })
    // Optionally: wrap existing provider instead of replacing
    return
  }
  
  // ... rest of init
}
```

**Effort:** 0.5 days  
**Risk:** Low — early return, no break.  
**Testing:** Initialize OTel before SDK, verify no conflict.

---

## High-Priority Fixes (P1)

### P1.1: Add parentSpanId to Custom Events

**File:** `src/tracing/tracer.ts`, `src/core/event-pipeline.ts`  
**Effort:** 0.5 days

Enrich custom `request`, `error`, and `message` events with `parentSpanId`. Required for full trace tree reconstruction.

```typescript
// In PulseSpan or enrichFromContext:
const activeSpan = trace.getSpan(otelContext.active())
if (activeSpan) {
  const spanContext = activeSpan.spanContext()
  enrichment['parentSpanId'] = spanContext.spanId
}
```

---

### P1.2: Sample All Event Types (Not Just Requests)

**File:** `src/core/event-pipeline.ts`  
**Effort:** 1 day

Currently only `request` events are sampled. Errors, messages, and metrics are always sent. This can overwhelm the queue during incidents.

```typescript
// Add to shouldSample() check:
if (event.type === 'error' || event.type === 'message' || event.type === 'metric') {
  return shouldSample(config.samplingRate, traceId)
}
```

---

### P1.3: Connection Pooling for HTTP Transport

**File:** `src/transport/http.ts`  
**Effort:** 1 day

Use `http.Agent` with `keepAlive` to reuse connections. Reduces connection setup overhead.

```typescript
import http from 'http'
import https from 'https'

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  freeSocketTimeout: 30000,
})

// Use in fetch via `agent` option (requires node-fetch or undici)
```

---

### P1.4: Add Request Timeout to `postJson` AbortController

**File:** `src/transport/http.ts`  
**Effort:** 0.5 days

Currently uses `AbortController` but no explicit timeout. Add timeout handling.

```typescript
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), timeoutMs)
// ... existing code
clearTimeout(timeout)
```

---

### P1.5: Unify requestId and spanId

**File:** `src/core/context.ts`  
**Effort:** 0.5 days

Currently `requestId` and `spanId` are independent. For a given HTTP request, there are two IDs tracking the same thing.

**Fix:** Set `requestId = spanId` when tracing context is extracted.

---

### P1.6: Validate maxPayloadBytes > 0

**File:** `src/transport/sender.ts`  
**Effort:** 15 minutes

Current code validates but the check happens late. Move to init time.

---

### P1.7: Add `beforeShutdown` Hook

**File:** `src/core/lifecycle.ts`  
**Effort:** 0.5 days

Allow users to hook into the shutdown lifecycle (e.g., flush custom state).

---

### P1.8: Expose Flush Progress

**File:** `src/transport/batcher.ts`  
**Effort:** 0.5 days

Add `onFlush` callback or event to `flush()` so users can track progress.

---

## Medium-Priority Fixes (P2)

| # | Fix | File | Effort |
|---|-----|------|--------|
| P2.1 | Use faster hash (xxhash) for dedup | `processors/deduplicator.ts` | 0.5d |
| P2.2 | Validate batchSize < maxQueueSize | `core/init.ts` | 15min |
| P2.3 | Optimize requeueFront (O(1) prepend) | `transport/queue.ts` | 0.5d |
| P2.4 | Logger serialization overhead | `utils/logger.ts` | 1d |
| P2.5 | Cleanup noopTracer on shutdown | `tracing/tracer.ts` | 15min |
| P2.6 | Instance isolation for retry budget | `transport/retry.ts` | 0.5d |
| P2.7 | Use EventLoopLagMonitor | `utils/event-loop-lag.ts` | 1d |
| P2.8 | Source map cache size limit | `processors/source-map-resolver.ts` | 0.5d |
| P2.9 | Configure slow request detector | `processors/slow-request-detector.ts` | 0.5d |
| P2.10 | Prevent processEvent during shutdown | `core/event-pipeline.ts` | 0.5d |
| P2.11 | Flush() respects rate limits | `transport/batcher.ts` | 0.5d |
| P2.12 | ALS context for worker_threads | `core/context.ts` | 1d |

---

## Architecture Changes

### A1: Separate Retry Queue

**Status:** Required for P0.6  
**Effort:** 1 day  
**Goal:** Prevent retry events from being evicted by new events.

### A2: Worker Thread Transport

**Status:** Required for 100K+ RPM  
**Effort:** 2 weeks  
**Goal:** Move transport (HTTP send, retry, circuit breaker) to a separate thread. Eliminates event loop blocking.

### A3: Multi-Ingest Failover

**Status:** Required for multi-region  
**Effort:** 1 week  
**Goal:** Support array of ingest URLs, failover to healthy backend, latency-aware routing.

### A4: OTel Native Metrics

**Status:** Required for v3.0  
**Effort:** 2 weeks  
**Goal:** Remove custom histogram computation entirely. Use OTel `Histogram` instruments only.

---

## OTel Migration Plan

### Phase 1: Foundation (Week 1)
- P0.3 (Histogram)
- P1.2 (Sampling)
- OTel auto-instrumentation (no custom wrapper)

### Phase 2: Tracing (Week 2)
- P0.4 (Context propagation)
- P1.1 (parentSpanId)
- P0.10 (Double-init guard)

### Phase 3: Metrics (Week 3)
- Full OTel metrics (remove custom reader)
- A4: OTel native metrics

### Phase 4: Sampling (Week 4)
- P1.2 (Sample all events)
- OTel `ParentBasedSampler`

---

## Implementation Phases

| Phase | Week | Fixes | Effort | Deliverable |
|-------|------|-------|--------|-------------|
| 1. Critical Transport | 1-2 | P0.1, P0.2, P0.6, P0.8 | 3 days | Stable queue, async persistence |
| 2. Tracing | 3 | P0.4, P0.10, P1.1, P1.5 | 2 days | Correct trace trees |
| 3. Memory & Safety | 4 | P0.5, P0.7, P0.9 | 2 days | Bounded memory, pressure gates |
| 4. Histograms | 5 | P0.3, A4 | 2 days | Correct percentiles |
| 5. Polish | 6 | P1.2, P1.3, P1.4, P1.7 | 3 days | Performance, hooks |
| 6. Testing | 7-8 | All | 1 week | Unit + integration tests |

**Total:** 6 weeks (1 engineer) or 3 weeks (2 engineers in parallel)

---

## Testing Requirements

| Test | Scope | Tool |
|------|-------|------|
| Graceful shutdown flush | Unit | Jest |
| Async persistence order | Unit | Jest + mock fs |
| Histogram accuracy | Unit | Known distributions |
| Span parent-child | Integration | OTel test utils |
| Memory pressure gate | Integration | heapdump, clinic.js |
| Retry priority queue | Unit | Jest |
| LRU bounded size | Unit | Jest |
| Circuit breaker state | Unit | Jest |
| Full pipeline (10K events) | Load | autocannon, clinic.js |
| Full shutdown (data loss prevention) | Integration | SIGTERM test |
| OTel double-init | Integration | manual |

---

## Rollback Plans

| Fix | Rollback | Method |
|-----|----------|--------|
| P0.1 (Shutdown flush) | Revert to `stopBatcher()` | Git revert |
| P0.2 (Async persistence) | Revert to `appendFileSync` | Git revert |
| P0.3 (Histogram) | Revert to linear interpolation | Git revert (restore backup) |
| P0.4 (Context) | Remove `otelContext.with` wrapper | Git revert |
| P0.5 (Memory gate) | Remove `if (critical)` check | Git revert |
| P0.6 (Retry queue) | Revert to single FIFO queue | Git revert |
| P0.7 (LRU) | Revert to `Map` | Git revert |
| P0.8 (CB reset) | Add `circuitBreaker.reset()` back | Git revert |
| P0.9 (ALS warning) | Remove log line | Git revert |
| P0.10 (OTel guard) | Remove early return | Git revert |

---

## Code Snippets

### Snippet 1: Graceful Shutdown
```typescript
export async function gracefulShutdown(timeoutMs: number = 10_000): Promise<void> {
  isRunning = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  
  const start = Date.now()
  while (eventQueue.size() > 0 && Date.now() - start < timeoutMs) {
    try { await flush() } catch { /* continue */ }
  }
  
  // DO NOT reset circuit breaker
  logger.debug('Batcher stopped', { remaining: eventQueue.size() })
}
```

### Snippet 2: Async Persistence
```typescript
import { appendFile } from 'fs/promises'

private async flushAsync(): Promise<void> {
  if (this.writeBuffer.length === 0) return
  const content = this.writeBuffer.join('\n') + '\n'
  this.writeBuffer = []
  await appendFile(this.dataFile, content, { encoding: 'utf8' })
}
```

### Snippet 3: Context Propagation
```typescript
import { context as otelContext, trace } from '@opentelemetry/api'

const ctx = trace.setSpan(otelContext.active(), otelSpan)
return otelContext.with(ctx, async () => {
  // span is now active in this context
})
```

### Snippet 4: Memory Pressure Gate
```typescript
const memState = memoryMonitor.getState()
if (memState.level === 'critical') {
  return false  // Drop event to protect host
}
```

### Snippet 5: LRU Map
```typescript
class LRUMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) { super() }
  set(key: K, value: V): this {
    if (this.size >= this.maxSize && !this.has(key)) {
      this.delete(this.keys().next().value)
    }
    return super.set(key, value)
  }
}
```

---

## Appendix: All Files Requiring Changes

| File | Fixes | Priority |
|------|-------|----------|
| `src/transport/batcher.ts` | P0.1, P0.6, P0.8, P1.3, P2.11 | Critical |
| `src/transport/queue.ts` | P0.6, P2.3 | Critical |
| `src/storage/persistent-storage.ts` | P0.2 | Critical |
| `src/metrics/otel-adapter.ts` | P0.3, A4 | Critical |
| `src/tracing/tracer.ts` | P0.4, P0.10, P1.1, P1.5, P2.5 | Critical |
| `src/core/event-pipeline.ts` | P0.5, P1.2, P2.2, P2.10 | Critical |
| `src/processors/deduplicator.ts` | P0.7, P2.1 | Critical |
| `src/core/context.ts` | P0.9, P2.12 | High |
| `src/transport/http.ts` | P1.3, P1.4 | High |
| `src/transport/sender.ts` | P1.6 | Medium |
| `src/core/lifecycle.ts` | P1.7 | Medium |
| `src/utils/logger.ts` | P2.4 | Medium |
| `src/utils/event-loop-lag.ts` | P2.7 | Medium |
| `src/processors/source-map-resolver.ts` | P2.8 | Low |
| `src/processors/slow-request-detector.ts` | P2.9 | Low |
| `src/instrumentation/auto-instrument.ts` | A4 (OTel migration) | High |

**Total files to modify:** 15  
**Total lines changed (est):** ~500  
**Risk of regression:** Low to Medium (fixes are isolated, no API breaks)

---

> **End of Document**
>
> This file serves as the single source of truth for all fixes. Engineering team can implement in any order, guided by the Priority column in each section.
