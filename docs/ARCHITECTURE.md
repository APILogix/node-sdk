# Pulse APM Node.js SDK — Architecture & System Design Manual

> **Package**: `@pulse-apm/node`  
> **Version**: 8.3.12  
> **Target Runtime**: Node.js `>= 18.19.0` (Native ESM & CommonJS)  
> **Classification**: Enterprise Observability Architecture & Engineering Specification  

---

## 1. Architectural Philosophy & Non-Negotiable Principles

The Pulse APM Node.js SDK is designed for mission-critical enterprise environments. Every subsystem adheres to five non-negotiable architectural invariants:

1. **Strict Fail-Open Safety (Application Inviolability)**:
   * Telemetry must **never crash or degrade** the host application. If any internal SDK subsystem encounters an unexpected exception, out-of-memory condition, or network failure, the error is caught, recorded internally, and the host application continues unhindered.
   * Telemetry startup performs exactly one bounded network request. If unreachable, the SDK fails open: the application boots instantly without active telemetry.
2. **Truthful Timing Attribution & Zero Duration Clamping**:
   * Synthetic span duration alteration or fabricated waterfall trees are forbidden. Spans record monotonic timestamps (`process.hrtime.bigint()`).
   * High-resolution exclusive duration calculation clearly separates internal Node.js event-loop CPU execution time from I/O wait time (databases, caches, HTTP clients).
3. **Server-Driven Remote Telemetry Policy**:
   * Runtime telemetry policy (sample rates, kill switches, PII blacklists, transport batching, payload ceilings) is authoritatively governed by the Pulse remote control plane.
   * Host application code configures only local process-level concerns (`apiKey`, optional endpoint proxy, container signal registration, fail-open deadlines).
4. **Zero Telemetry Loss via Cycle-Safe Orphan Recovery**:
   * In asynchronous distributed environments, intermediate spans may be delayed or lost. The SDK guarantees that database queries, cache calls, and outgoing HTTP spans are never silently dropped from waterfall views. Orphan subtrees are detected and safely grafted onto the trace root with bounded duration re-clamping.
5. **Memory-Bounded Asynchronous Pipeline**:
   * All internal queues (event queue, transport batch queues, trace aggregator maps, deduplication LRU caches) are strictly bounded with hard capacity ceilings.
   * Background work is throttled via deterministic adaptive pressure monitoring, preventing event-loop starvation and heap exhaustion.

---

## 2. High-Level System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   HOST APPLICATION                                      │
│                                                                                         │
│   HTTP Inbound (Express / Fastify)  ──►  Business Logic  ──►  Outbound I/O (DB / HTTP)   │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ AsyncLocalStorage Context Propagation
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                             @pulse-apm/node SDK CORE ENGINE                             │
│                                                                                         │
│  ┌───────────────────────┐   ┌────────────────────────┐   ┌──────────────────────────┐  │
│  │   Control Plane &     │   │   Auto-Instrumentation │   │   Error & Exception      │  │
│  │   Remote Config       │   │   (DB, HTTP, Framework)│   │   Instrumentation        │  │
│  │   • RemoteConfigClient│   │   • Mongoose (ESM safe)│   │   • uncaughtException    │  │
│  │   • ConfigManager     │   │   • Prisma ($extends)  │   │   • unhandledRejection   │  │
│  │   • .env / Origin Norm│   │   • Mongo (Startup Fltr│   │   • Process Warning Rtr  │  │
│  └───────────┬───────────┘   └───────────┬────────────┘   └────────────┬─────────────┘  │
│              │                           │                             │                │
│              ▼                           ▼                             ▼                │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                             SAMPLING & GOVERNANCE GATE                            │  │
│  │   • SamplingEngine (Remote Static Rates + Route Overrides)                        │  │
│  │   • Dynamic Adaptive Sampling (System Pressure: 80% / 50% / 10%)                  │  │
│  │   • 100% Error Preservation Invariant (Errors Exempt From Throttling)             │  │
│  │   • CostGovernor & TenantGovernor (Spans per trace & Rate Limits)                 │  │
│  └───────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                          │ Sampled Events                               │
│                                          ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                         EVENT PIPELINE & SANITIZATION                             │  │
│  │   • Step 1: Structural Validation & Schema Normalization                          │  │
│  │   • Step 2: Context Binding (TraceId, SpanId, RequestId, User, Tags, Breadcrumbs) │  │
│  │   • Step 3: Deep Security Scrubbing (Recursive JSON, URL UserInfo, Set-Cookie)    │  │
│  │   • Step 4: Pipeline Trace Deduplicator (60s Sliding LRU Cache, 10k items)        │  │
│  │   • Step 5: Error Deduplicator (Fingerprint SHA-256 Gate)                         │  │
│  │   • Step 6: User-Defined `beforeSend` / `beforeBreadcrumb` Hooks                  │  │
│  └───────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                          │ Enqueue                                      │
│                                          ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │                        UNIFIED TRANSPORT ROUTER & DRAIN                           │  │
│  │   • Isolated Route Queues (/v1/traces, /v1/spans, /v1/requests, /v1/errors, etc.) │  │
│  │   • Priority Queueing & Micro-Batching (100ms - 10s intervals)                    │  │
│  │   • Gzip Payload Compression & Circuit Breaker Backoff                            │  │
│  │   • Lifecycle Drain: SIGTERM / SIGINT Interceptor & await Pulse.shutdown()        │  │
│  └───────────────────────────────────────┬───────────────────────────────────────────┘  │
└──────────────────────────────────────────┼──────────────────────────────────────────────┘
                                           │ HTTP/1.1 Keep-Alive / TLS
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              PULSE APM CLOUD INGESTION                                  │
│                 (Fastify Ingest Gateway + Redis Lookup Delivery Cache)                  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Deep-Dive: The 10 Core SDK Subsystems

---

### Subsystem 1: Control Plane, Startup & Environment Discovery

* **Primary Files**:
  * [`src/core/init.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts)
  * [`src/core/remote-config-client.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/remote-config-client.ts)
  * [`src/core/config-manager.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-manager.ts)
  * [`src/utils/env-loader.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/env-loader.ts)
  * [`src/constants/defaults.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/constants/defaults.ts)

#### Architectural Role:
The Control Plane subsystem is responsible for authenticating the SDK, discovering host environment variables, pulling the authoritative remote policy snapshot, and dynamically updating running subsystems when remote configurations change.

#### Key Mechanisms & Implementation Details:
1. **Zero-Dependency Native `.env` Loader**:
   * Uses Node.js native `process.loadEnvFile()` (introduced in Node 20.6.0).
   * Implements a zero-dependency fallback regex parser for older runtimes that reads `.env` from `process.cwd()` and populates only previously unset keys in `process.env`.
2. **Endpoint Precedence Resolution**:
   * Ingestion endpoint priority:
     $$\text{options.endpoint} \;\to\; \text{PULSE\_ENDPOINT} \;\to\; \text{PULSE\_API\_URL} \;\to\; \text{PULSE\_BASE\_URL} \;\to\; \text{BACKEND\_URL} \;\to\; \text{SDK\_BASE\_URL} \;\to\; \text{http://127.0.0.1:5000}$$
3. **Sub-10ms Startup & IPv6 DNS Fallback Bypass**:
   * Node.js `fetch` (Undici) resolves `localhost` to IPv6 `::1` before falling back to `127.0.0.1`. When IPv6 is unconfigured or blocked, this incurs a 1,000–3,000ms OS socket timeout.
   * `resolveApiBaseUrl()` and `normalizeBaseUrl()` automatically rewrite `http://localhost[:port]` to `http://127.0.0.1[:port]`, eliminating DNS lookup delays.
   * Added `Connection: keep-alive` to reuse TCP connections.
   * Aligned with backend Redis lookup caches (`getApiKeyMapping` and `getInitDelivery`) for instant response.
4. **Atomic Remote Configuration Handshake**:
   * A single HTTP `POST /v1/init` request downloads the complete JSON snapshot.
   * The snapshot is verified against `REMOTE_CONFIG_SCHEMA_VERSION = 1` and deep-frozen via `Object.freeze()`.
   * On configuration updates via `POST /v1/sdk-config`, `ConfigManager` calculates a semantic diff (`ConfigDiff`) and notifies registered subscribers (`featureController`, `samplingEngine`, `transportRouter`, etc.).

---

### Subsystem 2: Distributed Tracing, Waterfall Aggregation & Orphan Recovery

* **Primary Files**:
  * [`src/tracing/tracer.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/tracer.ts)
  * [`src/tracing/trace-aggregator.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/trace-aggregator.ts)
  * [`src/tracing/with-span.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/with-span.ts)
  * [`src/tracing/background-span.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/background-span.ts)
  * [`src/tracing/context.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/context.ts)

#### Architectural Role:
Manages OpenTelemetry-compatible distributed trace contexts, aggregates individual child spans into hierarchical trace documents, calculates exclusive CPU execution time, and repairs truncated trees via bounded orphan recovery.

#### Key Mechanisms & Implementation Details:
1. **AsyncLocalStorage Context Propagation**:
   * Uses Node.js `AsyncLocalStorage` to propagate active span context across asynchronous promises, callbacks, and event emitters without manual context passing.
   * Generates standard W3C `traceparent` headers (`00-{traceId}-{spanId}-{flags}`) and `baggage` for outgoing HTTP requests.
2. **Cycle-Safe Bounded Orphan Span Recovery**:
   * When spans are flushed, `TraceAggregator.buildTree()` traverses the span tree starting from `rootSpanId` using direct child maps while maintaining a cycle-detection `visited` set.
   * If `visited.size < spans.length`, unvisited orphan spans (spans whose parent spans were delayed, dropped, or never exported) are clustered by their sub-roots and grafted directly onto `rootAggregated.children`.
   * Children are sorted chronologically by `startTime`.
   * Re-clamps `totalDuration = Math.max(totalDuration, maxEnd - minStart)` across all spans, guaranteeing zero missing database or HTTP spans in APM waterfall views.
3. **Detached Background Execution (`withBackgroundSpan`)**:
   * Standard in-request spans (`withSpan`) inherit the active HTTP request context. If an asynchronous task runs after `res.end()` (e.g. sending an email or publishing to Kafka), standard spans leak memory or attach to already-completed traces.
   * `withBackgroundSpan` breaks the synchronous hierarchy: it creates an independent root trace and links back to the originating HTTP request via a causal OpenTelemetry `SpanLink`.

---

### Subsystem 3: Error Tracking & Process Warning Routing

* **Primary Files**:
  * [`src/capture/captureError.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/capture/captureError.ts)
  * [`src/instrumentation/global-errors.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/global-errors.ts)
  * [`src/processors/sourcemap.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/sourcemap.ts)
  * [`src/processors/deduplicator.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/deduplicator.ts)

#### Architectural Role:
Captures synchronous and asynchronous exceptions, correlates them with the active distributed trace and HTTP request, extracts stack traces with source-map symbolication, deduplicates error bursts, and routes runtime deprecation warnings cleanly.

#### Key Mechanisms & Implementation Details:
1. **Process Warning Telemetry Routing**:
   * Previously, intercepting `console.error` treated all output as critical application errors.
   * Third-party drivers (such as `pg` emitting SSL deprecation notices) and Node runtime warnings (`(node:1234) [DEP0123] Warning: ...`) log via `console.error`.
   * The SDK implements `PROCESS_WARNING_PATTERN` to inspect messages. If a process or driver deprecation warning is detected, it is routed to `captureMessage(message, Severity.Warning)` instead of generating an APM error incident.
   * **Impact**: HTTP 200 responses are never falsely marked as errored; false PagerDuty alarms are eliminated.
2. **Error Fingerprinting & Deduplication**:
   * Computes a deterministic SHA-256 fingerprint from `error.name`, `error.message`, and the top non-internal stack frame.
   * Employs an LRU sliding window to suppress identical error storms from flooding network bandwidth and overwhelming downstream storage.
3. **Source Map Symbolication**:
   * Reads compiled `.map` files from the host container filesystem (`sourceMaps.paths`).
   * Maps minified bundle positions (e.g. `dist/index.js:1:14205`) back to original TypeScript source files (`src/routes/checkout.ts:42:15`).

---

### Subsystem 4: Sampling Engine & Dynamic Adaptive Pressure Throttling

* **Primary Files**:
  * [`src/core/sampling-engine.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/sampling-engine.ts)
  * [`src/utils/adaptive-pressure.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/adaptive-pressure.ts)
  * [`src/core/init.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts)

#### Architectural Role:
Evaluates sampling decisions for all telemetry event types (`traces`, `requests`, `spans`, `errors`, `metrics`, `logs`). In high-throughput services (>10,000 RPS), dynamically throttles non-error telemetry under system load while safeguarding 100% of errors.

#### Key Mechanisms & Implementation Details:
1. **Deterministic FNV-1a Hashing**:
   * Uses 32-bit FNV-1a hashing on `traceId` or `eventId`.
   * Normalized against $2^{32}$ ($0.0 \le \text{ratio} < 1.0$) for unbiased, reproducible sampling distribution across distributed microservices.
2. **Hierarchical Precedence**:
   1. Route-specific overrides (longest matching URL prefix wins).
   2. Global event-type sample rate from remote configuration.
3. **Dynamic Adaptive Pressure Scaling (>10,000 RPS)**:
   * Connected to the `adaptivePressure` monitor (tracking heap memory and event-loop lag):
     * **`HEALTHY`**: 100% of configured rate.
     * **`ELEVATED`**: Bounded to $\min(\text{rate}, \text{rate} \times 0.80)$.
     * **`PRESSURED`**: Bounded to $\min(\text{rate}, \text{rate} \times 0.50)$.
     * **`CRITICAL`**: Throttles non-error telemetry to at most $10\%$ ($\min(\text{rate}, 0.10)$).
4. **Strict Error Invariant**:
   * Errors (`eventType === 'errors'`) are **100% exempt** from adaptive pressure reduction. Even under `CRITICAL` memory pressure, every single error is captured and dispatched.

---

### Subsystem 5: Auto-Instrumentation & Native ESM Module Interception

* **Primary Files**:
  * [`src/instrumentation/manager.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/manager.ts)
  * [`src/instrumentation/mongoose.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/mongoose.ts)
  * [`src/instrumentation/mongodb.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/mongodb.ts)
  * [`src/instrumentation/prisma.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/prisma.ts)
  * [`src/instrumentation/http.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/http.ts)
  * [`src/instrumentation/express.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/express.ts)
  * [`src/instrumentation/fastify.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/fastify.ts)

#### Architectural Role:
Intercepts database drivers, HTTP clients, and web frameworks transparently without requiring developers to write boilerplate tracing code.

#### Key Mechanisms & Implementation Details:
1. **Synchronous ESM Loader Hooks (`import-in-the-middle`)**:
   * Node.js static ESM imports evaluate before module body execution. The SDK registers loader hooks via `--import @pulse-apm/node/register` to intercept modules at import time.
2. **Mongoose Native ESM Deferred Connection Patching**:
   * Inspects deferred connections (`globalThis.mongoose.conn?.base`, awaiting `globalThis.mongoose.promise`).
   * Patches all Mongoose prototypes (`Query.prototype.exec`, `Query.prototype.then`, `Model.prototype.save`, `Model.create`, `Aggregate.prototype.exec`).
   * Injects `PULSE_SUPPRESS_DB_DRIVER` symbol into the active OpenTelemetry context so underlying MongoDB driver spans are suppressed, ensuring **exactly one canonical span per query**.
3. **MongoDB Standalone Startup Command Suppression**:
   * Mongoose model initialization executes administrative index commands (`createIndexes`, `create`, `listIndexes`, `buildInfo`) before any web request arrives.
   * When these execute outside an active trace context (`!trace.getSpan(context.active())`), the SDK invokes the original driver method uninstrumented.
   * Eliminates hundreds of useless 1-span startup traces from flooding APM dashboards.
4. **Prisma Safe Extension Architecture**:
   * Avoids subclass constructor ordering bugs by using safe null-guards and lazy instantiation.
   * Utilizes Prisma `$extends` query interception on `$allModels.$allOperations`, capturing both standard queries and interactive transactions (`prisma.$transaction(async (tx) => ...)`).

---

### Subsystem 6: Event Pipeline, Validation & Trace Deduplication

* **Primary Files**:
  * [`src/core/event-pipeline.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/event-pipeline.ts)
  * [`src/processors/deduplicator.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/deduplicator.ts)
  * [`src/queue/event-queue.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/queue/event-queue.ts)

#### Architectural Role:
The central processing assembly line where raw telemetry events are enriched, scrubbed, deduplicated, and placed into prioritized delivery queues.

#### Pipeline Processing Steps (`processEventAsync`):
1. **Step 1: Ingestion & Kill Switch Check**: Verifies that SDK and event-type kill switches (`disableSDK`, `disableTracing`, etc.) are not active.
2. **Step 2: Schema Normalization**: Ensures mandatory fields (`eventId`, `timestamp`, `eventType`) conform to wire specs.
3. **Step 3: Distributed Context Binding**: Injects `traceId`, `spanId`, `requestId`, `service`, `environment`, and `release`.
4. **Step 4: Sampling Evaluation**: Consults `SamplingEngine`. If dropped, updates internal drop counters and exits.
5. **Step 5: Deep Recursive PII Scrubbing**: Runs attributes through `SecurityScrubber`.
6. **Step 6: Deduplication Gate**:
   * Step 6.5: `ErrorDeduplicator` checks error fingerprints.
   * Step 6.6: `TraceDeduplicator` checks trace IDs against a 60-second sliding window LRU cache (capacity: 10,000). Drops duplicate trace re-exports caused by concurrent flush intervals or network retries.
7. **Step 7: User Extension Hooks**: Invokes `beforeSend` and `eventProcessors`.
8. **Step 8: Enqueue & Dispatch**: Submits the event to `EventQueue` for micro-batch transport.

---

### Subsystem 7: Security, Privacy & Recursive Scrubbing

* **Primary Files**:
  * [`src/processors/security-scrubber.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/security-scrubber.ts)
  * [`src/constants/defaults.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/constants/defaults.ts)

#### Architectural Role:
Guarantees strict compliance with GDPR, SOC 2, HIPAA, and PCI-DSS by preventing sensitive credentials and personal data from leaking into telemetry payloads.

#### Key Mechanisms & Implementation Details:
1. **Recursive JSON String Parsing & Scrubbing**:
   * Telemetry attributes serialized into JSON strings (e.g. `payload: '{"password": "secret", "user": "admin"}'`) previously bypassed key blacklists.
   * `SecurityScrubber.scrubValue()` parses JSON strings, scrubs the parsed object recursively, and re-serializes the sanitized value.
2. **URL UserInfo & Query Parameter Redaction**:
   * Strips basic authentication credentials (`http://admin:secret@internal.api` $\to$ `http://[Redacted]:[Redacted]@internal.api`).
   * Redacts sensitive query parameter patterns (`apiKey`, `token`, `secret`, `password`, `auth`).
3. **Header Blacklist**:
   * Default scrubbed headers: `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`.
4. **Card Luhn Check & Regex Sanitization**:
   * Detects and masks 13–19 digit credit card numbers matching the Luhn checksum algorithm.
   * Masks Social Security Numbers, National IDs, and JWT tokens.

---

### Subsystem 8: Multi-Tenant Governance, Limits & Memory Protection

* **Primary Files**:
  * [`src/core/limits-engine.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/limits-engine.ts)
  * [`src/governance/cost-governor.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/governance/cost-governor.ts)
  * [`src/governance/tenant-governor.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/governance/tenant-governor.ts)
  * [`src/utils/memory-detector.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/memory-detector.ts)

#### Architectural Role:
Protects the host process from memory exhaustion, bounds payload sizes, enforces per-tenant rate limits in SaaS architectures, and limits runaway traces.

#### Key Mechanisms & Implementation Details:
1. **Cost Governor (Runaway Trace Prevention)**:
   * Enforces `maxSpansPerTrace` (default: 500 spans). When exceeded, subsequent spans are dropped and the trace is tagged with `pulse.trace_truncated = true`.
   * Enforces `maxTraceDurationMs` to prevent stale memory leaks from unclosed spans.
2. **Tenant Governor (Multi-Tenant Rate Limiting)**:
   * Enforces independent token-bucket rate limiters per `tenantId` to prevent a single noisy tenant from monopolizing event queues.
3. **Container Memory Auto-Detection**:
   * Reads Linux cgroups v1 (`/sys/fs/cgroup/memory/memory.limit_in_bytes`) and cgroups v2 (`/sys/fs/cgroup/memory.max`) to accurately detect Docker/Kubernetes container RAM ceilings rather than host machine memory.

---

### Subsystem 9: Unified Transport Router, Batching & Compression

* **Primary Files**:
  * [`src/core/transport-router.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/transport-router.ts)
  * [`src/core/lifecycle.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts)

#### Architectural Role:
Transmits telemetry payloads across isolated, prioritized HTTP routes with micro-batching, gzip compression, exponential backoff, and circuit breaker protection.

#### Key Mechanisms & Implementation Details:
1. **Route Isolation & Prioritization**:
   * Separate transport queues for each telemetry type:
     * `/v1/errors` (Priority: Critical, Batch Size: 100, Flush: 1,000ms)
     * `/v1/traces` (Priority: High, Batch Size: 500, Flush: 5,000ms)
     * `/v1/requests` (Priority: High, Batch Size: 500, Flush: 5,000ms)
     * `/v1/spans` (Priority: High, Batch Size: 500, Flush: 5,000ms)
     * `/v1/metrics` (Priority: Normal, Batch Size: 1,000, Flush: 10,000ms)
     * `/v1/logs` (Priority: Normal, Batch Size: 200, Flush: 10,000ms)
2. **Gzip Wire Compression**:
   * Payloads are compressed using native `zlib.gzip` before transmission, reducing network egress bandwidth by 85–95%.
3. **Circuit Breaker & Exponential Backoff**:
   * If the ingestion backend responds with HTTP 429 (Quota Exhausted) or 5xx, the route circuit breaker opens, pausing transmission and applying exponential backoff (`baseDelayMs: 500ms`, `maxRetries: 3`) to avoid retry storms.

---

### Subsystem 10: Lifecycle & Hardened Graceful Shutdown

* **Primary Files**:
  * [`src/core/lifecycle.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts)
  * [`src/core/init.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts)

#### Architectural Role:
Ensures zero data loss during container scaling, rolling Kubernetes deployments, and server shutdowns without delaying process termination.

#### Key Mechanisms & Implementation Details:
1. **Automatic Container Signal Handling**:
   * When `handleSignals: true` (the default), the SDK hooks `process.on('SIGTERM')` and `process.on('SIGINT')`.
   * Invokes `await shutdown()` to cleanly drain all buffered events.
2. **Multi-Stage Drain Sequence**:
   1. **Gate Closure**: Sets `client.destroyed = true`, rejecting new non-critical event ingress.
   2. **Tree Flush**: Flushes all active span aggregation trees and orphan-recovered spans to transport queues.
   3. **Concurrent Route Drain**: Dispatches all batches across all transport routes concurrently.
   4. **Timer Unreferencing**: Calls `.unref()` on all internal background timers so the Node.js event loop exits cleanly without hanging.
3. **Bounded Drain Deadline**:
   * Enforces `shutdownTimeoutMs` (default: 5,000ms) to ensure the SDK completes draining well before the container orchestrator sends `SIGKILL` (typically 30s in Kubernetes).

---

## 4. Verification & Automated Test Architecture

The SDK maintains a comprehensive automated testing matrix verified on Node.js 18, 20, and 22:

| Test Layer | Suite Count | Tests Run | Pass Rate | Scope |
|---|:---:|:---:|:---:|---|
| **Unit Tests** | 116 | 409 | **100%** | Individual algorithms (sampling, orphan recovery, regex, scrubbing, .env loading, deduplication) |
| **Integration Tests** | 14 | 50 | **100%** | End-to-end transport routing, batching, quota backoff, 429 recovery, and multi-service wiring |
| **Observability Platform** | 9 | 9 | **100%** | Forensic verification against 4,219 raw telemetry files |
| **TOTAL** | **139** | **468** | **100%** | **Zero failures, zero regressions** |
