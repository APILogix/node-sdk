# SDK-NODE ENTERPRISE-GRADE ARCHITECTURE ANALYSIS

## PHASE 1 — COMPREHENSIVE STRUCTURE ANALYSIS

This document provides a complete architectural reverse-engineering of the Pulse SDK codebase (`sdk-node`). The analysis is intended for review by senior engineers, staff engineers, platform engineers, SREs, backend architects, and observability experts.

---

## 1. FOLDER STRUCTURE OVERVIEW

```
sdk-node/
├── src/
│   ├── index.ts                    # Public API surface (semver-guaranteed)
│   ├── internals.ts                # Internal engine exports (no stability guarantee)
│   ├── capture/                    # Event capture APIs
│   ├── constants/                  # SDK defaults and versioning
│   ├── core/                       # Core SDK engine
│   ├── instrumentation/            # Framework integrations (OTel-based)
│   ├── metrics/                    # OTel-native metrics pipeline
│   ├── plugins/                    # Plugin system
│   ├── processors/                 # Event processing pipeline
│   ├── session/                    # Session management
│   ├── storage/                    # Persistent event storage
│   ├── subsystems/                 # Feature-controlled subsystems
│   ├── tracing/                    # Distributed tracing (OTel-based)
│   ├── transport/                  # Event transport, queueing, batching
│   ├── types/                      # TypeScript type definitions
│   └── utils/                      # Utilities and governors
├── tests/                          # Test suite
├── dist/                           # Compiled output
├── dist-tests/                     # Compiled test output
└── docs/                           # Documentation
```

---

## 2. LAYERED ARCHITECTURE VIEW

The SDK is organized into distinct architectural layers, each with specific responsibilities:

### Layer 1: Public API Surface (`src/index.ts`)
- **Purpose**: Public SDK contract with semver guarantees
- **Exports**: `createSDK`, `captureError`, `captureRequest`, `captureMessage`, `captureEvent`, `captureMetric`, `startSpan`, `withSpan`, `monitorMiddleware`, etc.
- **Boundary**: Only symbols documented here are stable; internal engines accessible via `./internals`

### Layer 2: Internal Engines (`src/internals.ts`)
- **Purpose**: Internal SDK surface for power users and testing
- **Exports**: `ConfigManager`, `KillswitchEngine`, `FeatureController`, `SamplingEngine`, `LimitsEngine`, `TransportRouter`, `tenantGovernor`, etc.
- **Guarantee**: NO STABILITY GUARANTEES — shapes can change without warning

### Layer 3: Core Engine (`src/core/`)
The heart of the SDK, containing initialization, configuration, and lifecycle management:

| Module | Responsibility | Key Exports |
|--------|---------------|-------------|
| `client.ts` | Singleton SDK state holder | `client` (plugins, config, metadata, breadcrumbs) |
| `init.ts` | SDK initialization orchestration | `init()`, multi-phase startup |
| `lifecycle.ts` | Graceful shutdown/crash flush | `shutdown()`, `flush()`, `crashFlush()` |
| `config-manager.ts` | Remote config fetcher + refresh | `getConfig()`, `onConfigChange()` |
| `sampling-engine.ts` | FNV-1a deterministic sampling | `shouldSampleTrace()`, `shouldSampleRequest()` |
| `limits-engine.ts` | Payload/attribute limits | `enforceAttributeLimits()`, `checkPayloadSize()` |
| `killswitch-engine.ts` | Reactive feature toggle | `isKilled()`, `isSDKDisabled()` |
| `feature-controller.ts` | Subsystem lifecycle management | `register()`, `isEnabled()`, `teardownAll()` |
| `scope.ts` | Request context + user/tags/extra | `setUser()`, `setTag()`, `withScope()` |
| `context.ts` | Trace/span context propagation | `getTraceId()`, `getSpanId()`, `getRequestContext()` |
| `event-pipeline.ts` | Async event processing | `enqueueEvent()`, `processEvent()` |

### Layer 4: Transport Layer (`src/transport/`)
Responsible for event transmission, queueing, batching, and resilience:

| Module | Responsibility | Key Features |
|--------|---------------|--------------|
| `transport-router.ts` | Unified transport singleton | Route resolution, health, config hot-swap |
| `queue.ts` | 3-tier priority queue | Critical/High/Normal priorities, adaptive shedding |
| `batch-manager.ts` | Per-route batching | Timer-based flush, batch size limits |
| `circuit-breaker.ts` | Failure detection | Trip on consecutive failures, half-open recovery |
| `retry.ts` | Exponential backoff | Retry budget, jitter, dead letter queue |
| `load-shedder.ts` | Pressure-aware rejection | Memory pressure, CPU pressure, saturation |
| `rate-limit.ts` | Token-bucket rate limiting | Per-route, per-tenant limits |
| `sender.ts` | HTTP transmission | Fetch-based, compression, serialization |

### Layer 5: Tracing (`src/tracing/`)
OpenTelemetry-native distributed tracing:

| Module | Responsibility |
|--------|---------------|
| `tracer.ts` | OTel NodeTracerProvider + PipelineSpanExporter |
| `span.ts` | PulseSpan wrapper around OTel Span |
| `context-propagation.ts` | W3C TraceContext extraction/injection |
| `span-duration.ts` | Exclusive duration computation |
| `trace-aggregator.ts` | Span tree reconstruction |
| `remote-config-sampler.ts` | Deterministic FNV-1a sampling |

### Layer 6: Metrics (`src/metrics/`)
OTel-native metrics with exponential histograms:

| Module | Responsibility |
|--------|---------------|
| `registry.ts` | MetricsRegistry facade (Counter, Gauge, Histogram, UpDownCounter) |
| `otel-adapter.ts` | MeterProvider with ExponentialHistogramAggregation |
| `pulse-metric-reader.ts` | Custom MetricReader → event pipeline |

### Layer 7: Processors (`src/processors/`)
Event transformation, normalization, and security:

| Module | Responsibility |
|--------|---------------|
| `normalizer.ts` | Fill defaults, truncate oversized fields |
| `sanitizer.ts` | PII redaction, header scrubbing |
| `security-scrubber.ts` | Remote-config-driven PII detection |
| `deduplicator.ts` | Error deduplication within time window |
| `fingerprint.ts` | Error grouping fingerprints |
| `stack-parser.ts` | Stack frame parsing |
| `source-map-resolver.ts` | Stack frame source mapping |
| `source-context.ts` | Error frame source context attachment |
| `slow-request-detector.ts` | Long-running request detection |

### Layer 8: Instrumentation (`src/instrumentation/`)
Framework integrations using OpenTelemetry:

| Module | Framework |
|--------|-----------|
| `express.ts` | Express.js |
| `fastify.ts` | Fastify |
| `http.ts` | Native HTTP/HTTPS |
| `graphql.ts` | GraphQL |
| `prisma.ts` | Prisma ORM |
| `mongodb.ts` | MongoDB |
| `pg.ts` | PostgreSQL (pg) |
| `mysql.ts` | MySQL |
| `redis.ts` | Redis |
| `bullmq.ts` | BullMQ |
| `axios.ts` | Axios HTTP client |
| `auto-instrument.ts` | Auto-registration of all instrumentations |
| `global-errors.ts` | Process-level uncaughtException/unhandledRejection |
| `http-lifecycle-guard.ts` | Request lifecycle hooks |

### Layer 9: Storage (`src/storage/`)
Crash recovery and persistence:

| Module | Responsibility |
|--------|---------------|
| `persistent-storage.ts` | NDJSON file persistence, replay on restart |
| `persistence-governor.ts` | Priority-aware persistence decisions |

### Layer 10: Session (`src/session/`)
User session tracking:

| Module | Responsibility |
|--------|---------------|
| `session-manager.ts` | Session lifecycle, crash-free rate calculation |

### Layer 11: Subsystems (`src/subsystems/`)
Feature-controlled background subsystems:

| Module | Responsibility |
|--------|---------------|
| `logging-subsystem.ts` | Log event capture |
| `profiling-subsystem.ts` | CPU profiling |
| `cron-subsystem.ts` | Cron health check monitoring |

### Layer 12: Utilities (`src/utils/`)
Governors and helpers:

| Module | Responsibility |
|--------|---------------|
| `backpressure.ts` | MemoryPressureMonitor |
| `adaptive-pressure.ts` | AdaptivePressureMonitor |
| `cardinality-governor.ts` | Metric cardinality limits |
| `cost-governor.ts` | Span-per-trace and trace-duration limits |
| `event-loop-lag.ts` | Event loop lag monitoring |
| `compression.ts` | Gzip/zstd compression |
| `logger.ts` | SDK internal logging |
| `resource-detector.ts` | OTel resource detection (host, container, cloud) |

---

## 3. DEPENDENCY GRAPH

### Core Dependencies (Initialization Order)

```
init() 
  → ConfigManager.initialize()         [Remote Config Fetch]
    → VersionPolicy.enforce()          [SDK Version Gate]
    → KillswitchEngine.initialize()    [Feature Toggle]
    → SamplingEngine.initialize()      [Sampling Decisions]
    → FeatureController.initialize()   [Subsystem Registry]
    → LimitsEngine.initialize()        [Payload Limits]
    → SecurityScrubber.initialize()    [PII Scrubbing]
    → TransportRouter.initialize()     [Event Transport]
      → ConnectionManager              [HTTP Pool]
      → BatchManager (per route)       [Batching]
      → Queue (per route)              [Priority Queue]
    → SessionManager.getSession()      [Session Tracking]
    → initTracer()                     [OTel Tracing]
      → NodeTracerProvider
      → BatchSpanProcessor
      → PipelineSpanExporter → event-pipeline
    → otelMetrics.init()               [OTel Metrics]
      → MeterProvider
      → PulseMetricReader → event-pipeline
    → setupGlobalErrorHandlers()       [Process-level]
    → registerSignalHandlers()         [SIGTERM/SIGINT]
    → persistentStorage.init()         [Crash Recovery]
    → featureController.register()     [Subsystem Start]
      → LoggingSubsystem.start()
      → ProfilingSubsystem.start()
      → CronSubsystem.start()
    → configManager.startRefreshLoop() [Background Config]
```

### Event Flow Dependencies

```
captureError / captureRequest / captureMessage / captureMetric
  → enqueueEvent() [Core Event Pipeline]
    → validate() → normalize() → sanitize() → enrichFromContext()
    → errorDeduplicator.isDuplicate()
    → applyScopeToEvent()
    → plugin.processEvent() [Plugin Pipeline]
    → eventProcessor() [User Processors]
    → beforeSend() [User Hook]
    → TransportRouter.send()
      → RouteRegistry.resolve()
      → BatchManager.enqueue()
        → Queue.add()
        → batcher.flush() [timer or size trigger]
          → Sender.send() [HTTP to backend]
    → persistenceGovernor.shouldPersist()
    → persistentStorage.persist() [Crash Recovery]
```

---

## 4. MODULE INTERACTION GRAPH

### Key Interaction Patterns

1. **Singleton Access Pattern**: Most engines expose `getInstance()`:
   - `ConfigManager.getInstance()`
   - `TransportRouter.getInstance()`
   - `FeatureController.getInstance()`
   - `KillswitchEngine.getInstance()`

2. **Event Pipeline Pattern**: All event capture flows through `event-pipeline.ts`:
   - Capture APIs call `enqueueEvent()`
   - Pipeline processes async via `setImmediate()`
   - Final routing to `TransportRouter.send()`

3. **Feature Controller Pattern**: Subsystems register via `FeatureController`:
   - `await featureController.register('tracing', startupFn, shutdownFn)`
   - Killswitches hook into subsystem lifecycle
   - Remote config changes propagate to active subsystems

4. **Remote Config Pattern**: Configuration flows:
   - `ConfigManager` fetches and caches remote config
   - `onConfigChange()` notifies all dependent engines
   - Engines apply diffs without full reinit

---

## 5. RUNTIME EXECUTION MAP

### Initialization Sequence (Phase 1-8 in init.ts)

| Phase | Action | Duration Impact |
|-------|--------|-----------------|
| 1 | Remote Config Fetch | Network I/O (3s timeout) |
| 2 | Version Policy Enforcement | In-memory |
| 3 | Control Plane Init | In-memory (Killswitch, Sampling, Features, Limits, Security) |
| 4 | Transport Router Init | Async (awaits previous shutdown) |
| 5 | Legacy Init Flow | Network I/O (init request) |
| 6 | Subsystem Registration | Per-subsystem (tracing, metrics, errors, logging, profiling, crons, session) |
| 7 | Config Change Listeners | In-memory |
| 8 | Config Refresh Loop | Timer-based (default 300s) |

### Event Processing Sequence

```
┌─────────────────────────────────────────────────────────────────────┐
│ SYNCHRONOUS (capture call)                                          │
├─────────────────────────────────────────────────────────────────────┤
│ 1. Validate options (Zod)                                           │
│ 2. Generate eventId + timestamp                                     │
│ 3. Check SDK shutdown flag → reject if true                        │
│ 4. Check pipelineDraining flag → reject if true                    │
│ 5. Check KillswitchEngine.isSDKDisabled() → reject if true         │
│ 6. Check LimitsEngine.admitEvent() → reject if rate-limited        │
│ 7. Check memory pressure → reject low-priority if critical         │
│ 8. Check LoadShedder.shouldShed() → reject if overloaded           │
│ 9. If !client.initialized → buffer to eventQueue (sync)            │
│ 10. If initialized → create Promise + setImmediate (async)         │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ ASYNCHRONOUS (setImmediate)                                         │
├─────────────────────────────────────────────────────────────────────┤
│ 11. Re-check killswitch                                             │
│ 12. EnsureBaseFields + assign eventId                              │
│ 13. Check feature flags (enableErrors, enableTracing, etc.)        │
│ 14. LimitsEngine.enforceAttributeLimits()                          │
│ 15. normalizeEvent() → fill defaults, truncate                     │
│ 16. enrichFromContext() → attach trace/span IDs, breadcrumbs       │
│ 17. errorDeduplicator.isDuplicate() → drop if dup                  │
│ 18. applyScopeToEvent() → attach user/tags/extra/context           │
│ 19. attachSourceContext() (errors only)                            │
│ 20. Plugin.processEvent() (each plugin)                            │
│ 21. EventProcessor (user-registered)                               │
│ 22. beforeSend hook (if allowed by plan)                           │
│ 23. Plugin.beforeSend (each plugin)                                │
│ 24. TransportRouter.send() → route to batch manager                │
│ 25. persistenceGovernor.shouldPersist() → persist if needed        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. FILE CLASSIFICATION BY CATEGORY

### Core Engine
- `src/core/client.ts` — SDK singleton state
- `src/core/init.ts` — Initialization orchestration
- `src/core/lifecycle.ts` — Shutdown/crash flush
- `src/core/config-manager.ts` — Remote config management
- `src/core/config.ts` — Config access
- `src/core/config-differ.ts` — Config diffing
- `src/core/config-validator.ts` — Remote config validation

### Transport
- `src/transport/transport-router.ts` — Unified transport
- `src/transport/queue.ts` — Priority event queue
- `src/transport/batch-manager.ts` — Per-route batching
- `src/transport/sender.ts` — HTTP transmission
- `src/transport/http.ts` — HTTP client wrapper
- `src/transport/connection-manager.ts` — HTTP connection pooling

### Instrumentation
- `src/instrumentation/express.ts` — Express middleware
- `src/instrumentation/fastify.ts` — Fastify plugin
- `src/instrumentation/http.ts` — HTTP instrumentation
- `src/instrumentation/auto-instrument.ts` — Auto-registration
- `src/instrumentation/global-errors.ts` — Process error handlers
- `src/instrumentation/graphql.ts` — GraphQL
- `src/instrumentation/prisma.ts` — Prisma
- `src/instrumentation/mongodb.ts` — MongoDB
- `src/instrumentation/pg.ts` — PostgreSQL
- `src/instrumentation/mysql.ts` — MySQL
- `src/instrumentation/redis.ts` — Redis
- `src/instrumentation/bullmq.ts` — BullMQ
- `src/instrumentation/axios.ts` — Axios

### Metrics
- `src/metrics/registry.ts` — MetricsRegistry facade
- `src/metrics/otel-adapter.ts` — OTel MeterProvider
- `src/metrics/pulse-metric-reader.ts` — Custom MetricReader

### Logging
- `src/subsystems/logging-subsystem.ts` — Log event capture
- `src/utils/logger.ts` — SDK internal logging

### Tracing
- `src/tracing/tracer.ts` — OTel tracer provider + exporter
- `src/tracing/span.ts` — PulseSpan wrapper
- `src/tracing/context-propagation.ts` — W3C TraceContext
- `src/tracing/span-duration.ts` — Exclusive duration
- `src/tracing/trace-aggregator.ts` — Span tree reconstruction
- `src/tracing/remote-config-sampler.ts` — Deterministic sampler

### Span Processing
- `src/tracing/tracer.ts` (PipelineSpanExporter class)
- `src/tracing/span-duration.ts`
- `src/tracing/trace-aggregator.ts`

### Error Capturing
- `src/capture/captureError.ts` — Error event capture
- `src/capture/captureMessage.ts` — Message event capture
- `src/processors/deduplicator.ts` — Error deduplication
- `src/processors/fingerprint.ts` — Error fingerprinting
- `src/processors/stack-parser.ts` — Stack parsing

### Batching
- `src/transport/batch-manager.ts` — Per-route batch aggregation
- `src/transport/batcher.ts` — Timer-based batch trigger

### Queueing
- `src/transport/queue.ts` — 3-tier priority queue
- `src/transport/transport-event-queue.ts` — Per-route queue

### Retry System
- `src/transport/retry.ts` — Exponential backoff
- `src/transport/circuit-breaker.ts` — Failure detection

### Sampling
- `src/core/sampling-engine.ts` — FNV-1a deterministic sampling
- `src/tracing/remote-config-sampler.ts` — OTel sampler integration

### Profiling
- `src/subsystems/profiling-subsystem.ts` — CPU profiling
- `src/capture/captureProfile.ts` — Profile capture

### Config Management
- `src/core/config-manager.ts` — Remote config fetcher
- `src/core/killswitch-engine.ts` — Feature toggles
- `src/core/feature-controller.ts` — Subsystem lifecycle
- `src/core/limits-engine.ts` — Payload limits
- `src/core/version-policy.ts` — SDK version gating
- `src/core/plan-gate.ts` — Plan-based feature gating

### Middleware
- `src/instrumentation/express.ts` — `monitorMiddleware()`
- `src/instrumentation/fastify.ts` — `fastifyPulsePlugin()`

### Utilities
- `src/utils/backpressure.ts` — Memory pressure monitoring
- `src/utils/adaptive-pressure.ts` — Adaptive pressure monitoring
- `src/utils/cardinality-governor.ts` — Metric cardinality limits
- `src/utils/cost-governor.ts` — Trace cost governance
- `src/utils/event-loop-lag.ts` — Event loop monitoring
- `src/utils/compression.ts` — Gzip compression
- `src/utils/time.ts` — Time utilities
- `src/utils/uuid.ts` — ID generation
- `src/utils/hash.ts` — Hashing utilities

### Integrations
- All files in `src/instrumentation/` — Framework adapters

### Framework Adapters
- `src/instrumentation/express.ts` — Express.js
- `src/instrumentation/fastify.ts` — Fastify
- `src/instrumentation/graphql.ts` — GraphQL
- `src/instrumentation/prisma.ts` — Prisma ORM
- `src/instrumentation/mongodb.ts` — MongoDB
- `src/instrumentation/pg.ts` — PostgreSQL
- `src/instrumentation/mysql.ts` — MySQL
- `src/instrumentation/redis.ts` — Redis
- `src/instrumentation/bullmq.ts` — BullMQ
- `src/instrumentation/axios.ts` — Axios

### API Layer
- `src/index.ts` — Public API
- `src/internals.ts` — Internal API

### Lifecycle Management
- `src/core/lifecycle.ts` — Shutdown/crash flush
- `src/core/feature-controller.ts` — Subsystem lifecycle

### Internal Hooks
- `src/instrumentation/http-lifecycle-guard.ts` — HTTP lifecycle hooks
- `src/instrumentation/event-emitter-patch.ts` — Event emitter patching

### Storage/Cache
- `src/storage/persistent-storage.ts` — NDJSON file persistence
- `src/storage/persistence-governor.ts` — Persistence decisions

### Serialization
- `src/transport/serialization-pool.ts` — JSON serialization pool
- `src/transport/serialization-worker.ts` — Worker-based serialization

### Compression
- `src/utils/compression.ts` — Gzip/zstd

### Network Layer
- `src/transport/sender.ts` — HTTP sender
- `src/transport/http.ts` — HTTP client wrapper
- `src/transport/connection-manager.ts` — Connection pooling

---

## 7. KEY ARCHITECTURAL INSIGHTS

### 7.1 OpenTelemetry-Native Design

The SDK fully embraces OpenTelemetry for tracing and metrics:
- **Tracing**: Uses `NodeTracerProvider` with `BatchSpanProcessor` and a custom `PipelineSpanExporter` that routes finished spans through the SDK event pipeline
- **Metrics**: Uses `MeterProvider` with `ExponentialHistogramAggregation` for O(1) per-record histogram bucket increments
- **Context**: Uses `AsyncLocalStorageContextManager` for async propagation
- **Propagation**: Uses W3C TraceContext propagator for distributed trace context

### 7.2 Deterministic Sampling

The SDK replaces random sampling with FNV-1a hash-based deterministic decisions:
- Same traceId → same sampling decision across all SDK instances
- Per-route sampling overrides via longest-prefix matching
- Sampling is hot-swappable via config refresh

### 7.3 Three-Tier Priority Queue

Events are classified into priority tiers:
- **Critical (40%)**: Errors, crashes — never shed unless hard limit
- **High (40%)**: Requests, spans — shed under critical pressure
- **Normal (20%)**: Metrics, messages, breadcrumbs — shed first

### 7.4 Async Non-Blocking Pipeline

Event processing is deferred via `setImmediate()` to avoid blocking the caller's request lifecycle:
- Capture returns immediately (synchronous acceptance)
- Processing happens in next event loop tick
- Per-step timeouts prevent slow processors from blocking

### 7.5 Feature-Controlled Subsystems

Subsystems (tracing, metrics, logging, profiling, crons) are registered with `FeatureController`:
- Startup/shutdown callbacks bound to killswitch toggles
- Remote config changes propagate without full reinit
- Disabled subsystems don't instantiate expensive resources

### 7.6 Persistence Governance

Events are selectively persisted based on priority:
- **Critical**: Always persisted for crash recovery
- **Important**: Persisted unless high memory pressure
- **Transient**: Persisted only under normal pressure

### 7.7 Circuit Breaker Pattern

The transport uses circuit breaker for resilience:
- **Closed**: Normal operation, requests flow
- **Open**: Consecutive failures detected, requests fail fast
- **Half-Open**: Probe requests test recovery

### 7.8 Load Shedding Architecture

Multiple load shedding mechanisms:
- **Memory Pressure**: Reject low-priority events at 92% heap utilization
- **Queue Pressure**: Shed lower-priority events when tier full
- **Rate Limiting**: Token-bucket per-route/tenant limits
- **Adaptive Pressure**: CPU and event loop lag monitoring

---

## 8. TRACE/SPAN RELATIONSHIPS

### Span Creation Flow

```
user code calls startSpan() or withSpan()
  → tracer.startSpan() / tracer.startActiveSpan()
  → OTel creates Span with parent context
  → PulseSpan wrapper created
  → User code runs with span active (AsyncLocalStorage)
  → span.end() called
  → BatchSpanProcessor queues span
  → Timer triggers batch export
  → PipelineSpanExporter.export() called
    → Transform OTel ReadableSpan → SDK event
    → Apply privacy.capture.* gates
    → Apply limits.maxSpanAttributes
    → Compute exclusive duration
    → Route through processEvent()
    → TransportRouter.send()
    → Persistence decision
```

### Context Propagation

- **Incoming**: `extractTraceContext()` uses W3C TraceContext propagator
- **Outgoing**: `injectTraceContext()` adds traceparent/tracestate headers
- **In-Process**: `AsyncLocalStorageContextManager` preserves context across async boundaries

---

## 9. ERROR PROPAGATION

### Error Capture Flow

```
try/catch in user code
  → captureError(error, options)
    → enqueueEvent()
      → normalizeEvent() (stack parsing)
      → enrichFromContext() (breadcrumbs)
      → errorDeduplicator.isDuplicate() (suppress repeats)
      → applyScopeToEvent() (user context)
      → plugin.processEvent()
      → beforeSend hook
      → TransportRouter.send()
        → errors route → BatchManager → Sender
```

### Error Deduplication

- Configurable time window (default: 5 seconds)
- Composite key: `fingerprint:service:release:tenantId:route`
- Suppressed errors tracked in memory with LRU eviction

---

## 10. TELEMETRY GENERATION

### Event Types

| Event Type | Capture Method | Priority | Persistence |
|------------|---------------|----------|-------------|
| `error` | `captureError()` | Critical | Always |
| `request` | `captureRequest()` | High | Important |
| `span` | OTel span end | High | Important |
| `message` | `captureMessage()` | Normal | Transient |
| `metric` | `captureMetric()` | Normal | Transient |
| `log` | LoggingSubsystem | Normal | Transient |
| `profile` | ProfilingSubsystem | Low | Transient |
| `cron_checkin` | `captureCronCheckIn()` | High | Important |
| `replay` | SessionManager | Low | Transient |

---

## 11. PERFORMANCE IMPLICATIONS

### Hot-Path Optimizations

1. **Memory Pressure Caching**: `process.memoryUsage()` syscall cached for 100ms
2. **SetImmediate over Promise**: Deferred processing uses `setImmediate` (single microtask) vs Promise (5 microtasks)
3. **FNV-1a Hashing**: O(n) string hash for deterministic sampling
4. **Exponential Histograms**: O(1) bucket increment vs O(n log n) sort-based percentiles
5. **Structured Clone + Freeze**: Config snapshots use efficient structuredClone

### Memory Management

- **Ring Buffer**: Breadcrumbs use fixed-size ring buffer (default 100)
- **Cardinality Governor**: Metric series limited per instrument (default 1000)
- **Cost Governor**: Max spans per trace (default 1000), max trace duration (default 30s)
- **Queue Bounded**: Total queue size capped (default 1000 events)

### Network Efficiency

- **Batching**: Events batched per route (errors: 100, traces: 500, metrics: 1000)
- **Compression**: Gzip compression available
- **Connection Pooling**: Shared HTTP connection manager with per-route limits
- **Serialization Pool**: Reusable JSON serialization buffers

---

## 12. DISTRIBUTED TRACING CORRECTNESS

### W3C Compliance

- **traceparent**: Full support with version 00 format
- **tracestate**: Supported and propagated
- **baggage**: Optional propagation via composite propagator

### Sampling Consistency

- Root span sampling decision propagates to children via OTel's `ParentBasedSampler`
- Deterministic FNV-1a ensures same traceId → same decision across instances

### Context Isolation

- `AsyncLocalStorageContextManager` isolates trace context per async operation
- No cross-request contamination in serverless/multi-tenant environments

### Span Attributes Security

- Privacy capture gates configurable via remote config:
  - `headers`: Strip http.request.header.* and http.response.header.*
  - `body`: Strip http.request.body and http.response.body
  - `query`: Strip URL query parameters
  - `cookies`: Strip cookie headers

---

## 13. SUMMARY

The Pulse SDK represents a mature, enterprise-grade observability platform with:

1. **OpenTelemetry-Native**: Full OTel integration for tracing and metrics with exponential histograms
2. **Deterministic Sampling**: FNV-1a hash-based sampling for consistent distributed tracing
3. **Async Non-Blocking**: Deferred processing via setImmediate to preserve request latency
4. **Priority-Based Queueing**: Three-tier priority system with adaptive load shedding
5. **Feature-Controlled Subsystems**: Hot-swappable subsystems via FeatureController
6. **Resilient Transport**: Circuit breaker, retry with exponential backoff, connection pooling
7. **Crash Recovery**: NDJSON persistent storage with replay on restart
8. **Security**: PII scrubbing, privacy capture gates, sensitive header redaction
9. **Performance**: Memory pressure monitoring, cardinality governance, cost controls

This architecture is suitable for high-scale production deployments with requirements for consistent sampling, comprehensive framework instrumentation, and resilient event delivery.