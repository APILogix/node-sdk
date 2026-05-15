# Changelog — Pulse SDK v2.0.0 (Phase 1: Foundation Hardening)

All notable changes to the Pulse SDK, introduced during the Phase 1 enterprise hardening sprint.

---

## [2.0.0] — 2026-05-15

### ⚡ Breaking Changes
- **None** — The existing public API (`init`, `captureError`, `captureRequest`, `monitorMiddleware`, `shutdown`, `flush`) remains fully backward-compatible.

---

### 🆕 New Features

#### Sentry-Style SDK API
- **`createSDK(options)`** — New ergonomic entry point (alias for `init()`).
- **`captureMessage(message, severity?, context?)`** — Capture arbitrary text messages at any severity level.
- **`captureMetric(name, value, type, options?)`** — Capture counters, gauges, and histograms.
- **`captureEvent(event)`** — Universal event capture entry point for custom event types.
- **`incrementCounter()` / `setGauge()` / `recordHistogram()`** — Convenience metric helpers.

#### Breadcrumbs
- **`addBreadcrumb({ category, message, level?, type?, data? })`** — Record events that happened before an error.
- Breadcrumbs auto-attach to error and message events from async context.
- Configurable ring-buffer capacity via `maxBreadcrumbs` option (default: 100).
- Breadcrumb types: `default`, `http`, `navigation`, `error`, `query`, `ui`, `user`.

#### Plugin System
- **Full lifecycle hooks**: `setup()`, `processEvent()`, `processBreadcrumb()`, `beforeSend()`, `afterSend()`, `onTransportError()`, `teardown()`.
- Register via `plugins: [myPlugin()]` in SDK init options.
- Error isolation — a failing plugin never blocks other plugins or the pipeline.
- Reverse-order teardown during shutdown.
- Duplicate plugin detection by name.

#### Event Pipeline (12-Step Processing)
Every captured event flows through:
1. Base field assignment (eventId, timestamp)
2. Pre-init buffering
3. Feature flag gate (errors, performance, metrics)
4. **Normalization** — fill defaults, truncate oversized strings/arrays/objects
5. **PII Sanitization** — deep scrub emails, credit cards, SSNs, phones, tokens, sensitive keys
6. **Context enrichment** — attach trace/span IDs, breadcrumbs from `AsyncLocalStorage`
7. Plugin `processEvent()` hooks
8. User-registered event processors
9. User `beforeSend()` hook
10. Plugin `beforeSend()` hooks
11. Sampling (configurable rate)
12. Queue enqueue

#### Transport Resilience
- **Circuit Breaker** — Three-state (CLOSED/OPEN/HALF_OPEN) protection against cascading failures.
  - Configurable failure threshold (default: 5 consecutive failures).
  - Configurable reset timeout (default: 30s).
  - Half-open probing with limited requests.
- **Token Bucket Rate Limiter** — Smooth burst limiting for batch sends (capacity: 10, refill: 2/sec).
- **Sliding Window Rate Limiter** — Alternative count-based rate limiter.
- **Concurrent Flight Limiting** — Max 3 in-flight batch sends by default.
- **Self-Rescheduling Timer** — Prevents overlapping batch ticks.

#### Compression
- **gzip** and **brotli** payload compression with automatic fallback (skips compression if it doesn't reduce size).
- Configurable via `transport.compression` option: `'gzip'` (default), `'brotli'`, `'none'`.

#### HTTP Transport Improvements
- `X-Request-ID` idempotency header on every request.
- `Retry-After` header parsing (seconds and HTTP-date formats).
- `X-RateLimit-Remaining` header parsing for server-side rate limit awareness.
- `Content-Encoding` header for compressed payloads.

#### Context Propagation
- Expanded `AsyncLocalStorage` context store:
  - `traceId` / `spanId` — OpenTelemetry trace correlation.
  - `userId` / `sessionId` — User-scoped telemetry.
  - `baggage` — W3C Baggage propagation.
  - `tags` / `extra` — Custom key-value data.
- `getTraceId()`, `getSpanId()`, `getRequestContext()` — Context accessor functions.
- `withContext(store, fn)` — Run code within an explicit context scope.

#### Severity System
- Full severity enum: `debug`, `info`, `warning`, `error`, `fatal`.
- `severityFromString()` — Parse with aliases (`'warn'` → `warning`, `'critical'` → `fatal`).
- `severityGte()` / `severityMeetsThreshold()` — Comparison operators.

#### Graceful Shutdown
- Configurable shutdown timeout via `shutdownTimeoutMs` (default: 10000ms).
- Automatic SIGTERM/SIGINT handler registration.
- Plugin teardown during shutdown (reverse registration order).
- Race between flush+teardown and timeout — events are not lost if flush completes in time.

#### Configuration Validation
- **Zod schema validation** for all `SDKInitOptions` at init time.
- Clear error messages with field paths for invalid config.
- Expanded `TransportOptions` sub-config: `batchSize`, `flushIntervalMs`, `maxRetries`, `timeoutMs`, `compression`, `maxPayloadBytes`, `maxConcurrentSends`.

#### Memory Safety
- **RingBuffer** — O(1) bounded circular buffer for breadcrumbs (replaces unbounded arrays).
- **MemoryPressureMonitor** — Polls heap usage and emits `'pressure'` events at configurable thresholds (elevated: 70%, critical: 90%).
- **Event normalizer** — Limits string length (8KB), array length (100), object depth (5) to prevent memory exhaustion from user data.

---

### 🔧 Improvements

#### Debug Logging
- **Sentry-style `console.log` output** — Replaced chalk-based colored logging with plain `[Pulse] DEBUG/INFO/WARN/ERROR` prefixed console output.
- Debug and info messages only print when `debug: true` is set in SDK options.
- Warnings and errors always print regardless of debug mode.
- PII redaction applied to all log output.

#### Error Fingerprinting
- **SHA-256** fingerprinting (upgraded from SHA-1).
- In-app stack frames prioritized for grouping.
- Dynamic value normalization: numbers → `<N>`, UUIDs → `<UUID>`, quoted strings → `<S>`.
- Custom fingerprint override support.

#### Stack Parsing
- Typed `StackFrame` interface with `inApp`, `module` fields.
- Windows backslash path normalization.
- ESM `file://` URL support.
- `eval` context parsing.
- Module extraction from filename (e.g., `services/payment`).

#### Express Middleware
- Per-request breadcrumb creation (`http` type).
- Configurable breadcrumb capacity from SDK config.
- Typed context store creation via `createContextStore()`.
- Header sanitization via `sanitizeHeaders()`.

#### Error Capture
- Backward-compatible API: `captureError(err, context)` still works.
- New options API: `captureError(err, { severity, fingerprint, context })`.
- Automatic breadcrumb attachment from async context.
- Trace/span ID correlation.

---

### 📦 Dependencies

#### Added
| Package | Version | Purpose |
|---------|---------|---------|
| `zod` | `^4.4.3` | Runtime config validation |
| `@opentelemetry/api` | `^1.9.1` | OTel core API (Phase 2 ready) |
| `@opentelemetry/sdk-trace-base` | `^2.7.1` | Trace processing |
| `@opentelemetry/sdk-trace-node` | `^2.7.1` | Node.js tracing |
| `@opentelemetry/context-async-hooks` | `^2.7.1` | Async context |
| `@opentelemetry/semantic-conventions` | `^1.41.1` | Standard attribute names |
| `@opentelemetry/sdk-metrics` | `^2.7.1` | Metrics SDK |
| `@opentelemetry/resources` | `^2.7.1` | Resource detection |

#### Removed
| Package | Reason |
|---------|--------|
| `chalk` | Replaced with plain `console.log/warn/error` |

---

### 📁 New Files Created

```
src/
├── capture/
│   ├── captureEvent.ts          # Universal event capture
│   ├── captureError.ts          # Error capture with fingerprinting
│   ├── captureMessage.ts        # Message capture with severity
│   ├── captureMetric.ts         # Metric capture (counter/gauge/histogram)
│   └── captureRequest.ts        # Request capture (delegates to pipeline)
├── core/
│   ├── context.ts               # Expanded async context (rewritten)
│   ├── event-pipeline.ts        # 12-step processing pipeline
│   ├── lifecycle.ts             # Graceful shutdown + signal handlers
│   └── ring-buffer.ts           # O(1) bounded circular buffer
├── plugins/
│   ├── index.ts                 # Plugin manager (init/teardown)
│   └── types.ts                 # Plugin type re-exports
├── processors/
│   ├── fingerprint.ts           # SHA-256 error fingerprinting
│   ├── normalizer.ts            # Event normalization + truncation
│   ├── sanitizer.ts             # Deep PII scrubbing
│   └── stack-parser.ts          # V8 stack frame parser (rewritten)
├── transport/
│   ├── circuit-breaker.ts       # 3-state circuit breaker
│   └── rate-limit.ts            # Token bucket + sliding window
├── types/
│   ├── breadcrumb.ts            # Breadcrumb interfaces
│   ├── config.ts                # SDKInitOptions + Zod schemas
│   ├── event.ts                 # Discriminated event union
│   ├── plugin.ts                # Plugin lifecycle interfaces
│   └── severity.ts              # Severity enum + utilities
└── utils/
    ├── backpressure.ts          # Memory pressure monitor
    ├── compression.ts           # gzip/brotli compression
    ├── hash.ts                  # SHA-256/HMAC utilities
    ├── time.ts                  # High-res timing
    └── uuid.ts                  # ID generation
```

### 📝 Files Modified

```
src/
├── core/
│   ├── client.ts                # Plugin registry, metadata, breadcrumbs added
│   └── init.ts                  # Zod validation, config merging, plugin init
├── transport/
│   ├── batcher.ts               # Circuit breaker + rate limiter integrated
│   └── http.ts                  # Compression, idempotency, rate-limit headers
├── instrumentation/
│   └── express.ts               # New context system, breadcrumbs
├── utils/
│   └── logger.ts                # Sentry-style console.log debug logging
└── index.ts                     # createSDK, expanded exports
```

---

### 🔮 Roadmap (Upcoming Phases)

| Phase | Focus | Status |
|-------|-------|--------|
| Phase 1 | Foundation Hardening | ✅ Complete |
| Phase 2 | OpenTelemetry Integration | 🔲 Next |
| Phase 3 | Framework Integrations (Fastify, NestJS, Koa) | 🔲 Planned |
| Phase 4 | Offline Persistence + Retry Queues | 🔲 Planned |
| Phase 5 | Profiling + Performance Monitoring | 🔲 Planned |
| Phase 6 | Multi-Region + Edge Support | 🔲 Planned |
