# Module Architecture

## 1. Directory Structure

The Pulse Node.js SDK source resides entirely within `src/` and is partitioned into well-defined domain boundaries:

```
src/
├── index.ts                      # Public API entry point and export contract
├── register.ts                   # Zero-code preload entry point (-r / --import)
│
├── analysis/                     # Offline and diagnostic trace analyzers
│
├── capture/                      # Direct telemetry capture functions
│   ├── captureError.ts
│   ├── captureEvent.ts
│   ├── captureMessage.ts
│   ├── captureMetric.ts
│   ├── captureRequest.ts
│   ├── captureLog.ts
│   ├── captureProfile.ts
│   └── captureCronCheckIn.ts
│
├── constants/                    # Shared system constants, endpoints, and version metadata
│   ├── defaults.ts
│   ├── endpoints.ts
│   └── version.ts
│
├── core/                         # Core runtime, lifecycle, config, and state management
│   ├── client.ts                 # Global SDK state and state machine
│   ├── init.ts                   # Single-flight initialization coordinator
│   ├── remote-config-client.ts   # /v1/init control-plane HTTP client
│   ├── recovery-worker.ts        # Background exponential backoff recovery worker
│   ├── feature-controller.ts     # Dynamic subsystem activation/deactivation
│   ├── lifecycle.ts              # Flush, graceful shutdown, and crashFlush
│   ├── context.ts                # Request context and AsyncLocalStorage bridge
│   ├── scope.ts                  # User, tags, extras, and breadcrumb scopes
│   ├── quota-controller.ts       # 429 quota exhaustion governor
│   └── error-classifier.ts       # Error categorization and fingerprinting
│
├── instrumentation/              # Framework, database, and protocol instrumentations
│   ├── index.ts                  # Instrumentation registry
│   ├── auto-instrument.ts        # Bootstrap and dynamic OpenTelemetry patch loader
│   ├── express.ts                # Express middleware & error handlers
│   ├── fastify.ts                # Fastify plugin
│   ├── http.ts                   # Native HTTP/HTTPS client instrumentation
│   ├── pg.ts                     # PostgreSQL client & pool instrumentation
│   ├── mysql.ts                  # MySQL2 instrumentation
│   ├── redis.ts                  # Redis and ioredis instrumentation
│   ├── mongodb.ts                # MongoDB driver instrumentation
│   ├── mongoose.ts               # Mongoose ODM instrumentation
│   ├── prisma.ts                 # Prisma ORM extension and middleware
│   ├── bullmq.ts                 # BullMQ job queue instrumentation
│   ├── nodemailer.ts             # Nodemailer email transport instrumentation
│   └── axios.ts                  # Axios client instrumentation
│
├── metrics/                      # Metrics registry and OpenTelemetry metric reader
│   ├── registry.ts               # In-memory metrics storage
│   ├── otel-adapter.ts           # OpenTelemetry SDK Metrics bridge
│   └── pulse-metric-reader.ts    # Periodic metric harvesting reader
│
├── plugins/                      # SDK extension and plugin architecture
│   └── index.ts                  # Plugin lifecycle and event hook hooks
│
├── processors/                   # In-flight event enrichment and scrubbing
│   ├── normalizer.ts             # Standardizes timestamps and attributes
│   ├── sanitizer.ts              # PII and credential scrubber
│   ├── deduplicator.ts           # Error fingerprint deduplication
│   ├── fingerprint.ts            # Stack trace hashing and grouping
│   ├── security-scrubber.ts      # Deep recursive object redactor
│   ├── stack-parser.ts           # V8 stack frame parser
│   └── source-map-resolver.ts    # In-memory source map resolution
│
├── session/                      # User session tracking and session replay
│   └── session-manager.ts        # Session expiration and telemetry binding
│
├── storage/                      # Local offline caching and spillover storage
│   ├── config-cache.ts           # Local filesystem configuration cache
│   ├── persistent-storage.ts     # Disk-backed event buffer for offline mode
│   └── persistence-governor.ts   # TTL and disk quota enforcement
│
├── subsystems/                   # Managed autonomous feature subsystems
│   ├── cron-subsystem.ts         # Periodic heartbeat and cron monitor
│   ├── logging-subsystem.ts      # Structured log processor
│   ├── profiling-subsystem.ts    # V8 CPU profiler controller
│   └── runtime-metrics-subsystem.ts # Node.js event-loop lag and GC metrics
│
├── tracing/                      # OpenTelemetry tracing implementation
│   ├── tracer.ts                 # PulseTracer: startSpan, withSpan, wrap
│   ├── context-propagation.ts    # W3C traceparent and baggage injection/extraction
│   ├── span-duration.ts          # Monotonic duration and event loop lag correction
│   ├── trace-aggregator.ts       # Cycle-safe orphan span grafting
│   ├── db-span.ts                # Database query span helper
│   └── remote-config-sampler.ts  # Adaptive remote sampling controller
│
├── transport/                    # Telemetry delivery, queuing, and serialization
│   ├── queue.ts                  # 3-tier bounded priority queue with strict ceiling
│   ├── batch-manager.ts          # Per-route batching and timed flusher
│   ├── transport-router.ts       # 10-route multiplexed transport engine
│   ├── circuit-breaker.ts        # Per-route delivery failure circuit breakers
│   ├── connection-manager.ts     # HTTP keep-alive socket pool manager
│   ├── serialization-pool.ts     # Worker thread pool for serialization/compression
│   ├── serialization-worker.ts   # Background thread worker implementation
│   ├── load-shedder.ts           # Memory pressure load shedder
│   └── rate-limit.ts             # Ingestion rate limit coordinator
│
├── types/                        # Core TypeScript type definitions
│   ├── config.ts                 # SDK options and remote config schema
│   ├── event.ts                  # Telemetry event schemas
│   ├── error.ts                  # Error classification types
│   ├── breadcrumb.ts             # Breadcrumb types
│   ├── severity.ts               # Severity enum and parser
│   └── transport.ts              # Route and batching options
│
└── utils/                        # Shared utility primitives
    ├── adaptive-pressure.ts      # Multi-dimensional system pressure calculator
    ├── backpressure.ts           # MemoryPressureMonitor
    ├── cardinality-governor.ts   # Metric attribute cardinality limiter
    ├── compression.ts            # Fast Gzip and Brotli streams
    ├── event-loop-lag.ts         # Event loop lag sampling via perf_hooks
    ├── memory-detector.ts        # Process memory and cgroup limit detector
    └── resource-detector.ts      # Cloud and container resource detection
```

---

## 2. Public vs. Internal Surfaces

The SDK enforces strict separation between public APIs and internal engines:

- **Public Surface (`src/index.ts`):** Only stability-guaranteed APIs are exported (`init`, `shutdown`, `flush`, `capture*`, `withSpan`, `withBackgroundSpan`, `monitorMiddleware`, `getSDKHealth`).
- **Internal Engines (`@pulse-apm/node/internals`):** Internal subsystems (`ConfigManager`, `TransportRouter`, `KillswitchEngine`, `FeatureController`) are hidden from root imports and accessible only via explicit, unstable internal sub-paths.
