# Pulse Node.js SDK — Authoritative Technical Documentation

Welcome to the definitive technical documentation for `@pulse-apm/node`. This documentation system provides an exhaustive, implementation-accurate reference for the architecture, lifecycle, telemetry pipeline, transport layer, OpenTelemetry integration, concurrency model, and operational characteristics of the SDK.

---

## Documentation Navigation

### 1. [Architecture](./architecture/overview.md)
Foundational architectural blueprints, process guarantees, and module interactions:
- [Architecture Overview](./architecture/overview.md) — High-level architecture, subsystem map, and guest-process invariants.
- [Runtime Model](./architecture/runtime-model.md) — The guest-process contract, event-loop ownership, and CPU/memory constraints.
- [Module Architecture](./architecture/module-architecture.md) — Concrete directory and subsystem layout across `src/`.
- [Lifecycle](./architecture/lifecycle.md) — Complete execution lifecycle from host import to shutdown.
- [State Machine](./architecture/state-machine.md) — Formal SDK state machine, legal transitions, and terminal boundaries.

### 2. [Initialization & Lifecycle](./initialization/initialization-flow.md)
Startup sequences, control-plane handshake, and self-healing:
- [Initialization Flow](./initialization/initialization-flow.md) — Step-by-step cold start execution (`/v1/init`, config validation).
- [Bootstrap Instrumentation](./initialization/bootstrap.md) — Early registration and monkey patching before config arrival.
- [Remote Configuration](./initialization/remote-config.md) — Control-plane payload schema, feature flags, and route parameters.
- [Background Recovery](./initialization/recovery.md) — Exponential backoff, jitter, Retry-After, and single-flight retry worker.
- [Late Activation](./initialization/late-activation.md) — Subsystem dynamic spin-up and cached configuration replay.
- [Initialization Shutdown](./initialization/shutdown.md) — Cancellation, abort signals, and race safety during startup.

### 3. [Telemetry Pipeline](./telemetry/overview.md)
Event models, admission control, and capacity enforcement:
- [Telemetry Overview](./telemetry/overview.md) — Supported telemetry pillars and public capture APIs.
- [Event Pipeline](./telemetry/event-pipeline.md) — From capture invocation to serialized transport transmission.
- [Event Types](./telemetry/event-types.md) — Concrete data schemas for errors, spans, metrics, requests, logs, and profiles.
- [Event Queue](./telemetry/queue.md) — Bounded 3-tier priority queue, strict capacity ceiling, and shedding.
- [Batching](./telemetry/batching.md) — Dynamic size/interval batching and timed flush windows.
- [Sampling](./telemetry/sampling.md) — Dynamic adaptive sampling, pressure states, and fatal error preservation.
- [Deduplication](./telemetry/deduplication.md) — LRU trace deduplication and fingerprint-based error aggregation.
- [Backpressure](./telemetry/backpressure.md) — Memory pressure monitoring, quota management, and load shedding.

### 4. [Transport & Ingestion](./transport/overview.md)
Network transport, multiplexed routes, and fault tolerance:
- [Transport Overview](./transport/overview.md) — Multi-route HTTP/HTTPS client and socket connection manager.
- [Ingestion](./transport/ingestion.md) — Telemetry payload formatting, headers, and endpoint ingestion.
- [Retry Policies](./transport/retry.md) — Network error classification, HTTP 429 quota handling, and backoff.
- [Circuit Breaker](./transport/circuit-breaker.md) — Per-route circuit breakers and self-healing state transitions.
- [Timeouts & Deadlines](./transport/timeouts.md) — Network socket timeouts, keep-alive reuse, and request aborts.
- [Failure Handling](./transport/failure-handling.md) — Transient network disruption vs. permanent configuration rejection.

### 5. [OpenTelemetry & Instrumentation](./instrumentation/opentelemetry.md)
Distributed tracing, context propagation, and framework hooks:
- [OpenTelemetry Integration](./instrumentation/opentelemetry.md) — NodeTracerProvider, MeterProvider, and singleton safety.
- [HTTP & Fetch Instrumentation](./instrumentation/http.md) — HTTP/HTTPS, Axios, Undici, and native fetch monkey patching.
- [Express & Fastify](./instrumentation/express.md) — Express middleware, Fastify plugin, and truth-preserving duration timing.
- [Database Instrumentation](./instrumentation/database.md) — PostgreSQL, MySQL, Redis, MongoDB, Mongoose, and Prisma tracing.
- [Manual Tracing](./instrumentation/tracing.md) — `startSpan`, `withSpan`, `withSpanSync`, `wrap`, and `withBackgroundSpan`.
- [Metrics Subsystem](./instrumentation/metrics.md) — Counters, Gauges, Histograms, and OpenTelemetry MetricReader.
- [Context Propagation](./instrumentation/context-propagation.md) — `AsyncLocalStorage`, W3C traceparent headers, and baggage.

### 6. [Processing Pipeline](./processing/normalization.md)
Event normalization, scrubbing, and data preparation:
- [Normalization](./processing/normalization.md) — Monotonic timestamp calculation and attribute standardization.
- [PII Sanitization](./processing/sanitization.md) — Deep recursive scrubber, secret redaction, and credit card masking.
- [Enrichment](./processing/enrichment.md) — Host, process, Git release, user identity, and scope tags.
- [Serialization](./processing/serialization.md) — Fast JSON serialization and payload size limits.
- [Compression](./processing/compression.md) — Gzip and Brotli compression with worker thread offloading.

### 7. [Performance & Event-Loop Safety](./performance/event-loop.md)
Audited performance guarantees and resource limits:
- [Event-Loop Safety](./performance/event-loop.md) — Zero synchronous I/O, lag monitoring, and guest-process invariants.
- [Memory Management](./performance/memory.md) — Bounded heap consumption, plateau guarantees, and buffer cleanup.
- [Worker Threads](./performance/worker-threads.md) — Serialization and compression offloading via thread pools.
- [Adaptive Backpressure](./performance/backpressure.md) — Load shedding under high system pressure.

### 8. [Configuration](./configuration/configuration.md)
Setup, configuration files, and remote management:
- [Static Configuration](./configuration/configuration.md) — Complete `SDKInitOptions` reference.
- [Environment Variables](./configuration/environment-variables.md) — Native `.env` discovery and override variables.
- [Remote Configuration](./configuration/remote-configuration.md) — Dynamic control-plane configuration reference.

### 9. [Shutdown & Teardown](./shutdown/lifecycle.md)
Termination handling and process cleanup:
- [Shutdown Lifecycle](./shutdown/lifecycle.md) — Step-by-step shutdown phases and execution order.
- [Graceful Shutdown](./shutdown/graceful-shutdown.md) — `SIGTERM`/`SIGINT` interceptors and in-flight queue draining.
- [Cancellation](./shutdown/cancellation.md) — AbortController propagation and zombie worker prevention.

### 10. [Security & Compliance](./security/api-keys.md)
Data protection, credential management, and privacy:
- [API Keys](./security/api-keys.md) — Authentication headers and token validation.
- [PII Sanitization](./security/pii-sanitization.md) — Automated credential masking and scrubbing rules.
- [Data Handling](./security/data-handling.md) — Local cache encryption, directory permissions, and transport security.

### 11. [Testing & Verification](./testing/testing-strategy.md)
Verification suites, test harnesses, and audit evidence:
- [Testing Strategy](./testing/testing-strategy.md) — Suite layout, mocked control-plane, and test runners.
- [Integration Tests](./testing/integration-tests.md) — Real framework and database integration coverage.
- [Adversarial Verification](./testing/adversarial-tests.md) — Red-team stress tests, attack vectors, and audit results.
- [Performance Tests](./testing/performance-tests.md) — Event-loop delay benchmarks and memory soak testing.

### 12. [Troubleshooting](./troubleshooting/common-issues.md)
Operational guides and error resolution:
- [Common Issues](./troubleshooting/common-issues.md) — Symptoms, diagnostic logs, and remediation.
- [Initialization Failures](./troubleshooting/initialization-failures.md) — Diagnosing control-plane timeouts and network drops.
- [Transport Failures](./troubleshooting/transport-failures.md) — Resolving HTTP 429 quota exhaustion and circuit trips.
- [Recovery Diagnostics](./troubleshooting/recovery.md) — Verifying background retry loops and state recovery.

### 13. [Development](./development/local-development.md)
Contributing to and releasing the SDK:
- [Local Development](./development/local-development.md) — Building, running, and debugging locally.
- [Build Pipeline](./development/build.md) — TypeScript compilation and `dist/` distribution separation.
- [Testing Guidelines](./development/testing.md) — Adding unit, integration, and load tests.
- [Release Process](./development/release.md) — Semantic versioning and npm publishing.
- [Branching Strategy](../BRANCHING.md) — Standardized Git branching model and release lifecycles.

---

## Core Invariant Summary

Every component in the Pulse SDK adheres to three non-negotiable operational invariants:

1. **Guest-Process Contract:** The customer application owns the Node.js event loop. The SDK must never block application startup, synchronously stall request handling, or terminate the host process via `process.exit()`.
2. **Failure Isolation:** Any internal failure within the SDK (network timeout, backend outage, serialization error, invalid configuration) must remain entirely contained within the SDK without escalating into host application failures.
3. **Bounded Memory & CPU:** Telemetry queues, buffers, and background operations operate under strict, pre-configured ceilings. If limits are reached, the SDK deterministically sheds telemetry to protect the host's stability.
