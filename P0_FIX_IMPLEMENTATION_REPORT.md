# Pulse SDK v2.0.0 - P0 Fix Implementation Report

## Root Cause Analysis

| P0 | Root Cause | Fix |
|---|---|---|
| Duplicate instrumentation | Manual HTTP, Express, and Fastify code created spans and monkey patches alongside OTel auto-instrumentation. | Legacy APIs are now compatibility shims. Tracing is owned by OTel `HttpInstrumentation`, `ExpressInstrumentation`, `FastifyInstrumentation`, and `UndiciInstrumentation`. |
| Context ownership split | SDK-owned `AsyncLocalStorage` carried trace/span IDs separately from OTel. | `ContextStore` is metadata-only and is stored on the active OTel context. Trace IDs and span IDs come from `trace.getActiveSpan()`. |
| Sampling inconsistency | SDK request-event sampling duplicated span sampling and could break trace consistency. | Tracing uses OTel `ParentBasedSampler` with `TraceIdRatioBasedSampler`; child spans inherit root decisions. |
| Retry queue loss | Failed batches were requeued into the same bounded queue and could be dropped under normal queue pressure. | Retry traffic has a dedicated priority lane and failed batches are persisted before requeue. |
| Shutdown loss | Shutdown flushed queue before OTel spans/metrics were force-flushed into the pipeline. | Shutdown now force-flushes tracing/metrics first, drains pending async processing, flushes transport, and persists remaining events on timeout. |
| Sync event pipeline | Plugins, processors, and `beforeSend` ran synchronously on capture path. | Capture remains API-compatible, but initialized processing is scheduled async with timeout isolation for plugin hooks. |
| Sync persistence | Persistence used sync append/read/rewrite filesystem calls. | Persistence now uses `fs/promises` with ordered write chaining and async shutdown flush. |
| OTel double initialization | SDK could register duplicate provider/context manager instances. | Pulse-owned provider registration is guarded by process-wide symbols and reuses an existing Pulse provider. |
| Histogram percentile math | OTel histogram percentiles were guessed from min/max. | Fake percentile computation was removed. Histograms are recorded as OTel exponential histograms; percentile computation belongs to the collector/backend. |
| Memory pressure | Capture path accepted low-priority telemetry under critical heap pressure. | Capture now rejects non-critical events under critical memory pressure and protects the host process first. |
| Self-instrumentation | SDK HTTP transport could be traced by fetch/Undici instrumentation. | Transport fetch runs under OTel tracing suppression and marks internal requests; OTel hooks ignore `/v1/init` and `/v1/events`. |

## Fixed Architecture

Tracing lifecycle is now OTel-native:

- OTel owns instrumentation, propagation, active context, sampling, and span lifecycle.
- Manual instrumentation modules are no-op compatibility shims.
- SDK manual `withSpan()` APIs use OTel active spans instead of detached spans.
- `ContextStore` carries request metadata, breadcrumbs, tags, user/session data, and extras only.

Telemetry pipeline remains SDK-owned:

- Normalization, sanitization, enrichment, plugins, persistence, batching, retries, and ingestion stay custom.
- Event processing is async-safe after SDK init.
- Retry traffic is prioritized above new telemetry.
- Shutdown drains OTel processors, pending event processing, transport queue, and persistence.

Metrics are hybrid but OTel-first:

- Histograms use OTel exponential histogram aggregation.
- The SDK no longer emits fabricated p50/p95/p99 values from min/max.
- Counter/gauge custom aggregation remains for lightweight SDK ingestion compatibility.

## Performance Impact

- Capture path is lower latency after initialization because plugin and `beforeSend` execution is deferred out of the direct caller path.
- Persistence no longer blocks the event loop with synchronous file writes.
- OTel HTTP/Express/Fastify/Undici instrumentation removes duplicate manual spans and duplicate monkey-patching overhead.
- Critical memory pressure now drops low-priority capture before it can amplify host memory pressure.
- Retry queue priority reduces data loss risk during backend failures without allowing unbounded in-memory growth.

## Scalability Analysis

The SDK is safer for high-volume services because:

- Root sampling happens once through OTel and propagates consistently.
- Failed sends persist before retry requeue, allowing recovery after restarts.
- Shutdown ordering prevents spans/metrics from being generated after queue flush.
- Async persistence and async event processing reduce request-path blocking.
- Self-instrumentation guards prevent recursive exporter/retry/replay spans.

Remaining scale work for millions of events/minute:

- Move transport serialization/compression to worker threads.
- Add multi-endpoint ingest failover.
- Add adaptive sampling based on queue depth and memory pressure.
- Add direct OTLP/protobuf export option for high-cardinality metrics and spans.
- Add load tests that run for hours, not just smoke coverage.

## Verification Results

| Requirement | Status | Evidence |
|---|---|---|
| Exactly one root span per request | Implemented | Manual request/span creation removed; OTel framework instrumentations own server spans. |
| No duplicate spans | Implemented | Manual HTTP/Express/Fastify instrumentation is no-op. |
| No orphan spans | Implemented | `withSpan()` uses OTel active span context. |
| Correct parent-child relationships | Implemented | `ParentBasedSampler` and OTel context manager own active context propagation. |
| No telemetry loss during retries | Implemented | Failed batches persist before retry requeue; retry queue drains first. |
| No telemetry loss during shutdown | Implemented | Tracer/metrics flush before queue flush; remaining queue persists on shutdown cleanup. |
| No event loop blocking under load | Improved | Pipeline and persistence are async-safe; CPU-heavy user plugins still require user discipline or future worker isolation. |
| Correct p95/p99 histograms | Implemented by architecture | SDK records OTel exponential histograms; backend/collector computes percentiles. |
| No recursive instrumentation | Implemented | Transport fetch uses OTel `suppressTracing`; OTel hooks ignore SDK endpoints. |
| Stable memory under pressure | Improved | Critical memory pressure gate and bounded retry lane are in place. |
| Correct async context propagation | Implemented | OTel context manager is the tracing authority; SDK metadata is stored in OTel context. |
| No duplicate OTel providers | Improved | Pulse-owned providers are process-guarded; full host-owned provider detection remains a future hardening item. |

Commands run:

```bash
npm run build
npm test
```

Result: build and smoke tests pass.

## Remaining Future Risks

1. Host-owned OTel provider detection is conservative. The SDK avoids duplicate Pulse-owned providers, but fully detecting arbitrary host providers needs deeper integration with app configuration.
2. Async timeout isolation cannot stop CPU-bound synchronous plugin code once it starts running. Worker-thread plugin execution is the next step for strict isolation.
3. Retry persistence protects failed batches, but replay policy should add stronger deduplication to prevent duplicate delivery after partial sends.
4. OTel percentile correctness depends on the collector/backend preserving histogram buckets and calculating quantiles correctly.
5. Very high throughput still needs worker-thread transport, streaming serialization, and endpoint-level failover to reach millions of events per minute reliably.
