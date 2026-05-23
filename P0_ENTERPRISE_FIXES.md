# Pulse SDK v2.0.0 - P0 Enterprise Fixes

## Compatibility Policy

All P0 fixes should preserve the existing public API. Internals may become async-aware, but exported user-facing functions should keep their current call patterns unless a new optional API is introduced.

## P0.1 Flush Queue on Shutdown

**Problem:** queued telemetry can be dropped during process shutdown.  
**Files:** `src/transport/batcher.ts`, `src/core/lifecycle.ts`, `src/core/client.ts`

**Fix:**
- Add an idempotent `flush(timeoutMs)` method to the batcher.
- Register lifecycle shutdown hooks that call `await client.flush()`.
- Stop accepting new events after shutdown starts.
- Bound shutdown latency with a timeout.

## P0.2 Replace Sync Persistent Storage I/O

**Problem:** `persistent-storage.ts` can block the event loop under high write volume.  
**Files:** `src/storage/persistent-storage.ts`

**Fix:**
- Replace synchronous append/read/remove operations with `fs.promises`.
- Serialize writes through an internal promise chain to keep NDJSON ordering.
- Keep current public methods as compatibility wrappers where needed.
- Add backpressure limits for disk replay and persistence queue size.

## P0.3 Move Histogram Handling to OTel Built-In Histograms

**Problem:** custom percentile calculation from histogram buckets is risky and can be mathematically wrong.  
**Files:** `src/metrics/otel-adapter.ts`, `src/metrics/registry.ts`

**Fix:**
- Use OTel `Meter.createHistogram()` for histogram recording.
- Store raw SDK metric events only when the ingestion API requires SDK-formatted payloads.
- Avoid custom percentile estimation inside the SDK hot path.
- Let the collector/backend calculate percentiles from OTel histogram streams.

## P0.4 Fix Span Context Propagation

**Problem:** custom `withSpan` logic can create broken trace trees.  
**Files:** `src/tracing/tracer.ts`, `src/tracing/context-propagation.ts`, `src/core/context.ts`

**Fix:**
- Use OTel context APIs to activate spans.
- Bridge SDK scope state with active OTel context.
- Ensure custom events include `traceId`, `spanId`, and `parentSpanId` when available.
- Add tests for nested spans, async callbacks, Express middleware, Fastify hooks, HTTP, and fetch.

## P0.5 Add Memory Pressure Gate

**Problem:** queues, deduplication maps, and retry paths can grow under backend outage or traffic spikes.  
**Files:** `src/core/event-pipeline.ts`, `src/transport/queue.ts`, `src/processors/deduplicator.ts`

**Fix:**
- Add a central memory-pressure check before enqueue and retry requeue.
- Drop or sample low-priority telemetry first.
- Emit internal diagnostics when telemetry is dropped.
- Bound all maps and queues with explicit maximum sizes.

## P0.6 Prevent Duplicate OTel and SDK Metric Emission

**Problem:** metrics may be emitted both through custom SDK events and OTel exports.  
**Files:** `src/metrics/otel-adapter.ts`, `src/capture/captureMetric.ts`

**Fix:**
- Define one primary path per metric type.
- Use OTel as the source of truth for counters, gauges, and histograms.
- Keep custom capture compatibility by forwarding into the OTel adapter and, optionally, mirroring to ingestion payloads.

## P0.7 Bound Deduplicator State

**Problem:** deduplication state can become unbounded.  
**Files:** `src/processors/deduplicator.ts`

**Fix:**
- Replace plain `Map` retention with TTL plus maximum entry count.
- Evict oldest entries when the limit is reached.
- Expose safe defaults in config.

## P0.8 Detect Existing OTel Providers

**Problem:** SDK initialization can conflict with applications that already configure OTel.  
**Files:** `src/core/init.ts`, `src/tracing/tracer.ts`, `src/metrics/otel-adapter.ts`

**Fix:**
- Detect existing global tracer and meter providers.
- Avoid overwriting host-owned providers by default.
- Add config such as `otel.mode: "auto" | "sdk-managed" | "external"`.

## P0.9 Enterprise Transport Hardening

**Problem:** high-scale deployments need stronger transport controls.  
**Files:** `src/transport/*`

**Fix:**
- Add request timeout, proxy support, and optional mTLS configuration.
- Support multiple ingest endpoints with failover.
- Add retry budgets per endpoint.
- Prefer keep-alive agents and connection reuse.

## P0.10 Runtime Diagnostics

**Problem:** operational failures are hard to understand without SDK self-diagnostics.  
**Files:** `src/utils/logger.ts`, `src/core/client.ts`, `src/transport/*`

**Fix:**
- Add internal counters for dropped events, flush failures, retry exhaustion, queue depth, persistence depth, and circuit breaker state.
- Keep diagnostics local by default.
- Allow users to subscribe to SDK health events.
