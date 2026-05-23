# Pulse SDK v2.0.0 - Enterprise Implementation Roadmap

## Guiding Constraints

- Preserve backwards compatibility for public SDK APIs.
- Move metrics semantics toward OTel-native instruments, especially histograms.
- Keep custom SDK value-adds where they are product-specific.
- Add tests with each fix, especially around shutdown, async context, retry behavior, and metric recording.

## Phase 1 - Critical Data Safety

**Target:** week 1

1. Add `flush()` and shutdown draining across batcher, queue, sender, and lifecycle.
2. Add bounded queue behavior and retry requeue safety.
3. Add memory-pressure gating before enqueue and retry.
4. Add tests for shutdown with pending queue and backend failure.

**Exit criteria:**
- No queued events are dropped on graceful shutdown unless timeout is reached.
- Queue and retry limits are deterministic.
- Dropped telemetry is counted and diagnosable.

## Phase 2 - OTel Metrics Migration

**Target:** week 2

1. Replace custom histogram percentile computation with OTel built-in Histogram instruments.
2. Keep `captureMetric()` compatibility by forwarding existing calls into the registry or OTel adapter.
3. Prevent duplicate custom and OTel metric emission.
4. Add compatibility tests for counters, gauges, histograms, and existing metric payload shapes.

**Exit criteria:**
- Histograms are recorded through OTel APIs.
- Existing SDK metric capture calls still work.
- Percentiles are no longer computed incorrectly in the SDK hot path.

## Phase 3 - Async Persistence and Replay

**Target:** week 3

1. Convert persistence implementation to async file I/O.
2. Add ordered write serialization.
3. Bound replay batch size and disk persistence depth.
4. Add corruption-tolerant NDJSON replay handling.

**Exit criteria:**
- Persistence no longer blocks request processing with sync disk I/O.
- Replay cannot exhaust memory on large persisted files.
- Bad persisted lines are skipped with diagnostics.

## Phase 4 - Trace Context Correctness

**Target:** week 4

1. Fix `withSpan` to activate spans through OTel context.
2. Bridge SDK scope and OTel active span data.
3. Add `parentSpanId` to custom event correlation where available.
4. Test Express, Fastify, HTTP, fetch, nested spans, and async callbacks.

**Exit criteria:**
- Nested spans form valid trace trees.
- Request events correlate with active traces.
- Manual custom spans preserve context across async boundaries.

## Phase 5 - Enterprise Transport

**Target:** weeks 5-6

1. Add keep-alive connection reuse and request timeout enforcement.
2. Add proxy and optional mTLS configuration.
3. Support multiple ingest endpoints with failover.
4. Add endpoint-level circuit breaker and retry budget accounting.

**Exit criteria:**
- SDK can run in enterprise network environments.
- Backend outage behavior is bounded and observable.
- Failover behavior is deterministic.

## Phase 6 - Production Hardening

**Target:** weeks 7-8

1. Add runtime SDK health diagnostics.
2. Add config reload strategy for safe runtime toggles.
3. Add compatibility and migration notes.
4. Expand stress tests for high-throughput scenarios.

**Exit criteria:**
- Users can understand SDK health in production.
- Migration can ship as a v2-compatible minor release where possible.
- Breaking changes, if any, are isolated for a future major release.
