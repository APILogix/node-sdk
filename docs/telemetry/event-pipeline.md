# Telemetry Event Pipeline

## 1. End-to-End Pipeline Diagram

Every telemetry record follows a multi-stage, high-throughput pipeline designed to isolate the host application from serialization and network overhead:

```
[ Developer Invokes captureError / withSpan / monitorMiddleware ]
                             |
                             v
           1. Normalization (src/processors/normalizer.ts)
              - Standardize timestamps (ISO 8601 + Monotonic ms)
              - Assign unique UUIDv4 eventId
              - Normalize error objects & circular references
                             |
                             v
           2. PII Sanitization (src/processors/sanitizer.ts)
              - Redact sensitive keys (password, token, secret)
              - Mask credit card patterns & Authorization headers
                             |
                             v
           3. Context Enrichment (src/core/scope.ts & context.ts)
              - Attach active TraceId / SpanId from AsyncLocalStorage
              - Attach User scope, tags, and extra metadata
              - Attach recent breadcrumb trail
                             |
                             v
           4. Fingerprinting & Deduplication (src/processors/)
              - Generate deterministic stack trace hash
              - Drop duplicate errors within deduplication window
                             |
                             v
           5. Dynamic Sampling (src/tracing/remote-config-sampler.ts)
              - Evaluate head/tail sampling rates
              - Preserve critical errors (bypass sampling)
                             |
                             v
           6. Bounded Queue Admission (src/transport/queue.ts)
              - Check global capacity ceiling (default: 1000)
              - Enforce priority tiering (Critical > High > Normal)
              - Evict or shed lower-priority items under pressure
                             |
                             v
           7. Route Batching (src/transport/batch-manager.ts)
              - Assemble batches per route (errors, traces, metrics)
              - Trigger flush on batchSize or flushIntervalMs
                             |
                             v
     ================ Worker Thread Boundary ================
     (src/transport/serialization-pool.ts for large payloads)
                             |
           8. Serialization & Compression
              - JSON stringification
              - Gzip or Brotli compression
                             |
     ========================================================
                             |
                             v
           9. Network Transport (src/transport/transport-router.ts)
              - HTTP POST with keep-alive socket reuse
              - Handle 429 Retry-After & circuit breakers
```

---

## 2. Pipeline Execution Characteristics

| Pipeline Stage | Execution Context | Typical Latency | Blocking Impact |
|---|---|---|---|
| **1. Normalization** | Synchronous (Caller Thread) | 2–8 μs | Imperceptible |
| **2. Sanitization** | Synchronous (Caller Thread) | 5–25 μs | Imperceptible |
| **3. Enrichment** | Synchronous (Caller Thread) | 2–5 μs | Imperceptible |
| **4. Deduplication** | Synchronous (Caller Thread) | 1–3 μs | Imperceptible |
| **5. Sampling** | Synchronous (Caller Thread) | 0.5 μs | None |
| **6. Queue Admission** | Synchronous (Caller Thread) | 1–2 μs | None |
| **7. Batching** | Asynchronous Timer / Microtask | 10–50 μs | None (Event Loop Idle) |
| **8. Serialization** | Worker Thread Pool (> 50KB) | 1–5 ms | Off Main Thread |
| **9. Compression** | Worker Thread Pool (> 50KB) | 2–8 ms | Off Main Thread |
| **10. Transport** | Non-blocking Socket I/O | Asynchronous | None |
