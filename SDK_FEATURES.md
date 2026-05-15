# Pulse SDK — Feature Reference & Remote Config Guide

**Version**: 2.0.0  
**Package**: `@vikasbaplawat1/pulse-sdk`  
**Runtime**: Node.js 18+  
**Module Format**: ESM

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Core Features](#core-features)
3. [Configuration & Remote Config](#configuration--remote-config)
4. [Error Tracking](#error-tracking)
5. [Distributed Tracing (OpenTelemetry)](#distributed-tracing-opentelemetry)
6. [Metrics](#metrics)
7. [Session Management](#session-management)
8. [Breadcrumbs](#breadcrumbs)
9. [Context Propagation](#context-propagation)
10. [Framework Integrations](#framework-integrations)
11. [Transport & Resilience](#transport--resilience)
12. [Plugin System](#plugin-system)
13. [Security & PII Scrubbing](#security--pii-scrubbing)
14. [Event Processing Pipeline](#event-processing-pipeline)
15. [Public API Reference](#public-api-reference)

---

## Quick Start

```typescript
import { createSDK, captureError, captureMessage, startSpan, withSpan } from '@vikasbaplawat1/pulse-sdk'

// Initialize the SDK
await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  service: 'payments-service',
  environment: 'production',
  release: '1.4.2',
  debug: true,
  enableTracing: true,
  enableMetrics: true,
  transport: {
    compression: 'gzip',
    batchSize: 25,
    flushIntervalMs: 5000,
  },
  plugins: [/* your plugins */],
})

// Capture errors
try {
  await processPayment(order)
} catch (err) {
  captureError(err, { context: { orderId: order.id } })
}

// Capture messages
captureMessage('User completed onboarding', 'info')

// Distributed tracing
const result = await withSpan('db.query.findUser', async (span) => {
  span.setAttribute('db.system', 'postgresql')
  span.setAttribute('db.statement', 'SELECT * FROM users WHERE id = $1')
  return await db.query('SELECT * FROM users WHERE id = $1', [userId])
})
```

---

## Core Features

| Feature | Status | Description |
|---------|--------|-------------|
| **Error Tracking** | ✅ Production | Automatic stack parsing, fingerprinting, severity levels |
| **Distributed Tracing** | ✅ Production | OpenTelemetry-based spans with W3C context propagation |
| **Metrics** | ✅ Production | Counters, gauges, histograms |
| **Session Management** | ✅ Production | Automatic session tracking with crash-free rates |
| **Breadcrumbs** | ✅ Production | Event timeline for debugging, ring-buffer backed |
| **Context Propagation** | ✅ Production | AsyncLocalStorage-based trace/span/user/tags correlation |
| **Express Middleware** | ✅ Production | Per-request context, automatic request capture |
| **Fastify Plugin** | ✅ Production | Per-request tracing, W3C context, breadcrumbs |
| **HTTP Client Instrumentation** | ✅ Production | Auto-trace outbound HTTP/HTTPS calls |
| **Plugin System** | ✅ Production | Full lifecycle hooks with error isolation |
| **PII Scrubbing** | ✅ Production | Deep regex-based sanitization of sensitive data |
| **Transport Resilience** | ✅ Production | Circuit breaker, rate limiting, retry, compression |
| **Graceful Shutdown** | ✅ Production | Signal handlers, flush timeout, plugin teardown |
| **Remote Config** | ✅ Production | Server-driven feature flags and ingestion settings |

---

## Configuration & Remote Config

### SDK Init Options

```typescript
interface SDKInitOptions {
  /** Required. Your project API key. */
  apiKey: string

  /** Service name for telemetry attribution. Default: 'unknown-service' */
  service?: string

  /** Deployment environment. Default: 'development' */
  environment?: string

  /** Release/version tag. Default: '0.0.0-unknown' */
  release?: string

  /** Enable debug console logging. Default: false */
  debug?: boolean

  /** Enable error event capture. Default: remote config */
  enableErrors?: boolean

  /** Enable performance/request event capture. Default: remote config */
  enablePerformance?: boolean

  /** Enable OpenTelemetry tracing. Default: true */
  enableTracing?: boolean

  /** Enable metric event capture. Default: true */
  enableMetrics?: boolean

  /** Sampling rate (0.0 to 1.0). Default: remote config */
  sampleRate?: number

  /** Maximum breadcrumbs per context. Default: 100 */
  maxBreadcrumbs?: number

  /** Shutdown timeout in ms. Default: 10000 */
  shutdownTimeoutMs?: number

  /** Transport configuration. */
  transport?: TransportOptions

  /** Plugins to register. */
  plugins?: SDKPlugin[]

  /** Event processors — transform events before send. */
  eventProcessors?: EventProcessor[]

  /** Called before each event is sent. Return null to drop. */
  beforeSend?: (event: SDKEvent) => SDKEvent | null

  /** Custom base URL override (set via SDK_BASE_URL env var). */
  baseUrl?: string
}
```

### Transport Options

```typescript
interface TransportOptions {
  /** Events per batch. Default: remote config (typically 10) */
  batchSize?: number

  /** Milliseconds between batch flushes. Default: remote config (typically 1000) */
  flushIntervalMs?: number

  /** Max retries per batch send. Default: remote config (typically 3) */
  maxRetries?: number

  /** Request timeout in ms. Default: 5000 */
  timeoutMs?: number

  /** Compression algorithm: 'gzip', 'brotli', or 'none'. Default: 'none' */
  compression?: 'gzip' | 'brotli' | 'none'

  /** Max payload size in bytes before splitting. Default: remote config */
  maxPayloadBytes?: number

  /** Max concurrent in-flight batch sends. Default: 3 */
  maxConcurrentSends?: number
}
```

### Remote Config (Server → SDK)

The SDK fetches configuration from the server during `init()`. This is the payload the server returns:

```json
{
  "success": true,
  "projectId": "proj_abc123",
  "config": {
    "samplingRate": 1.0,
    "enableErrors": true,
    "enablePerformance": true,
    "maxRetries": 3,
    "maxPayloadBytes": 524288
  },
  "ingestion": {
    "endpoint": "https://ingest.pulse.dev/v1/events",
    "batchSize": 10,
    "maxQueueSize": 1000,
    "flushInterval": 1000
  }
}
```

#### Remote Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `config.samplingRate` | `number` | `1.0` | Fraction of events to send (0.0–1.0) |
| `config.enableErrors` | `boolean` | `true` | Gate for error event capture |
| `config.enablePerformance` | `boolean` | `true` | Gate for request/perf event capture |
| `config.maxRetries` | `number` | `3` | Max retry attempts per batch |
| `config.maxPayloadBytes` | `number` | `524288` | Max bytes per HTTP payload |
| `ingestion.endpoint` | `string` | — | Ingestion endpoint URL |
| `ingestion.batchSize` | `number` | `10` | Events per batch |
| `ingestion.maxQueueSize` | `number` | `1000` | Max events in memory queue |
| `ingestion.flushInterval` | `number` | `1000` | Batch tick interval in ms |

#### Config Merging Priority

```
User-provided options > Remote config > SDK defaults
```

The SDK validates all config fields using Zod schemas. Invalid remote config triggers retry with exponential backoff (up to 5 attempts).

### Resolved SDK Config

After init, all config is merged into a single `ResolvedSDKConfig`:

```typescript
interface ResolvedSDKConfig {
  // Identity
  service: string
  environment: string
  release: string
  debug: boolean

  // Feature flags
  enableErrors: boolean
  enablePerformance: boolean
  enableTracing: boolean
  enableMetrics: boolean

  // Sampling
  samplingRate: number

  // Breadcrumbs
  maxBreadcrumbs: number

  // Queue
  maxQueueSize: number

  // Lifecycle
  shutdownTimeoutMs: number

  // Transport
  ingestUrl: string
  batchSize: number
  flushIntervalMs: number
  maxRetries: number
  timeoutMs: number
  compression: 'gzip' | 'brotli' | 'none'
  maxPayloadBytes: number
  maxConcurrentSends: number
}
```

---

## Error Tracking

```typescript
import { captureError, captureMessage } from '@vikasbaplawat1/pulse-sdk'

// Basic error capture
captureError(new Error('Payment failed'))

// With options
captureError(error, {
  severity: 'fatal',
  fingerprint: 'payment-gateway-timeout',
  context: { orderId: '12345', amount: 99.99 },
  tags: { team: 'payments', region: 'us-east-1' },
  mechanism: 'try-catch',
})

// Capture messages at any severity
captureMessage('User completed checkout', 'info')
captureMessage('Rate limit approaching', 'warning')
```

### Error Processing Pipeline

1. **Stack Parsing** — V8, Windows, ESM, eval-aware stack frame extraction
2. **In-App Classification** — Marks frames from `node_modules` as external
3. **PII Sanitization** — Scrubs sensitive data from error messages and stack traces
4. **SHA-256 Fingerprinting** — Groups errors by normalized in-app stack frames
5. **Breadcrumb Attachment** — Timeline of events leading to the error
6. **Context Enrichment** — Trace ID, span ID, user ID, tags from async context

### Auto-Capture

The SDK automatically captures:
- `uncaughtException` — with best-effort flush before crash
- `unhandledRejection` — captured and continues execution

---

## Distributed Tracing (OpenTelemetry)

The SDK integrates OpenTelemetry for enterprise-grade distributed tracing.

### Architecture

```
Your App → PulseSpan → OTel NodeTracerProvider → PipelineSpanExporter → SDK Event Pipeline → Ingestion
```

Spans flow through the same event pipeline as errors and metrics, benefiting from:
- PII sanitization
- Plugin processing
- Rate limiting
- Circuit breaking
- Batch transport

### Usage

```typescript
import { startSpan, withSpan, withSpanSync, getActiveSpan } from '@vikasbaplawat1/pulse-sdk'

// Manual span creation
const span = startSpan('db.query', {
  attributes: { 'db.system': 'postgresql', 'db.name': 'users' }
})
try {
  const result = await db.query(sql)
  span.setStatus('ok')
} catch (err) {
  span.recordError(err)
  span.setStatus('error')
} finally {
  span.end()
}

// Automatic span lifecycle (recommended)
const user = await withSpan('findUser', async (span) => {
  span.setAttribute('user.id', userId)
  return await userService.find(userId)
})

// Synchronous spans
const config = withSpanSync('loadConfig', (span) => {
  return JSON.parse(fs.readFileSync('config.json', 'utf-8'))
})

// Access active span
const active = getActiveSpan()
active?.setAttribute('custom.key', 'value')
```

### W3C Context Propagation

```typescript
import { extractTraceContext, injectTraceContext, createTraceparent, parseTraceparent } from '@vikasbaplawat1/pulse-sdk'

// Extract trace context from incoming request headers
const context = extractTraceContext(req.headers)

// Inject trace context into outgoing request headers
const headers: Record<string, string> = {}
injectTraceContext(headers)
// headers now contains: traceparent, tracestate, x-pulse-trace-id, x-pulse-span-id

// Manual traceparent creation
const tp = createTraceparent(traceId, spanId, true)
// => "00-{traceId}-{spanId}-01"

// Parse a traceparent header
const parsed = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
// => { version: "00", traceId: "4bf92f...", parentId: "00f067...", traceFlags: 1 }
```

### Resource Detection

The tracer automatically detects and attaches:

| Attribute | Source |
|-----------|--------|
| `service.name` | SDK config `service` |
| `service.version` | SDK config `release` |
| `deployment.environment.name` | SDK config `environment` |
| `host.name` | `os.hostname()` |
| `host.arch` | `os.arch()` |
| `os.type` | `os.type()` |
| `os.version` | `os.release()` |
| `process.pid` | `process.pid` |
| `process.runtime.name` | `'node'` |
| `process.runtime.version` | `process.version` |
| `telemetry.sdk.name` | `'@vikasbaplawat1/pulse-sdk'` |
| `telemetry.sdk.version` | `'2.0.0'` |
| `telemetry.sdk.language` | `'nodejs'` |

---

## Metrics

```typescript
import { captureMetric, incrementCounter, setGauge, recordHistogram } from '@vikasbaplawat1/pulse-sdk'

// Generic metric capture
captureMetric('http.request.duration', 142.5, 'histogram', {
  unit: 'ms',
  tags: { method: 'POST', route: '/api/orders' },
})

// Convenience helpers
incrementCounter('orders.created', { region: 'us-east-1' })
setGauge('connections.active', 42, { pool: 'primary' })
recordHistogram('query.duration', 23.4, { db: 'users', unit: 'ms' })
```

### Metric Types

| Type | Description | Use Case |
|------|-------------|----------|
| `counter` | Monotonically increasing value | Request counts, error counts |
| `gauge` | Point-in-time value | Memory usage, active connections |
| `histogram` | Distribution of values | Latency, response sizes |

---

## Session Management

```typescript
import { getSessionManager } from '@vikasbaplawat1/pulse-sdk'

const sessions = getSessionManager()

// Get current session (auto-creates if none)
const session = sessions.getSession()
console.log(session.id)        // UUID
console.log(session.startedAt) // epoch ms

// Record activity (resets idle timer)
sessions.recordActivity()

// Record error (marks session as crashed)
sessions.recordError()

// Get crash-free rate
const rate = sessions.getCrashFreeRate() // 0.0 to 1.0

// Get session health summary
const health = sessions.getSessionHealth()
// { totalSessions, crashedSessions, crashFreeRate, currentSessionId, currentSessionAge }
```

### Session Lifecycle

- **Idle timeout**: 30 minutes (configurable)
- **Max duration**: 4 hours (configurable)
- Auto-created on first `getSession()` call
- Ended on shutdown or expiry
- Crash-free rate tracked across all sessions

---

## Breadcrumbs

```typescript
import { addBreadcrumb } from '@vikasbaplawat1/pulse-sdk'

addBreadcrumb({
  category: 'user.action',
  message: 'Clicked checkout button',
  level: 'info',
  type: 'user',
  data: { buttonId: 'checkout-cta', page: '/cart' },
})

addBreadcrumb({
  category: 'db.query',
  message: 'SELECT * FROM orders WHERE user_id = $1',
  level: 'debug',
  type: 'query',
  data: { duration: 23, rows: 15 },
})
```

### Breadcrumb Types

| Type | Use Case |
|------|----------|
| `default` | General purpose |
| `http` | HTTP request/response (auto-created by instrumentation) |
| `navigation` | Page/route changes |
| `error` | Error occurrences |
| `query` | Database queries |
| `ui` | User interface interactions |
| `user` | User actions |

### Storage

Breadcrumbs are stored in a **RingBuffer** (O(1) bounded circular buffer). When the buffer is full, the oldest breadcrumbs are evicted. Default capacity: 100 per context.

---

## Context Propagation

```typescript
import { getRequestContext, getTraceId, getSpanId, addBreadcrumb } from '@vikasbaplawat1/pulse-sdk'

// Inside a request context (Express/Fastify middleware)
const ctx = getRequestContext()
// { requestId, traceId, spanId, userId, sessionId, baggage, tags, extra }

const traceId = getTraceId()   // string | undefined
const spanId = getSpanId()     // string | undefined
```

### Context Store Fields

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | `string` | Unique request identifier |
| `traceId` | `string?` | OpenTelemetry trace ID |
| `spanId` | `string?` | OpenTelemetry span ID |
| `userId` | `string?` | Authenticated user ID |
| `sessionId` | `string?` | Session identifier |
| `baggage` | `Map<string,string>?` | W3C Baggage propagation |
| `tags` | `Record<string,string>?` | Custom key-value tags |
| `extra` | `Record<string,unknown>?` | Custom metadata |
| `breadcrumbs` | `RingBuffer<Breadcrumb>` | Event timeline |

---

## Framework Integrations

### Express

```typescript
import express from 'express'
import { monitorMiddleware } from '@vikasbaplawat1/pulse-sdk'

const app = express()
app.use(monitorMiddleware)
```

Creates per-request async context with:
- Automatic request event capture (method, URL, status, latency)
- Trace/span ID correlation
- Breadcrumb creation for each request
- Header sanitization (sensitive headers redacted)

### Fastify

```typescript
import Fastify from 'fastify'
import { fastifyPulsePlugin } from '@vikasbaplawat1/pulse-sdk'

const app = Fastify()
app.register(fastifyPulsePlugin, {
  ignorePaths: ['/health', '/ready'],
  captureHeaders: true,
  captureQuery: true,
  maxBreadcrumbs: 100,
})
```

### HTTP Client (Auto-Instrumentation)

```typescript
import { instrumentHttpClient } from '@vikasbaplawat1/pulse-sdk'

// Call once during app startup
instrumentHttpClient()

// Now all http.request/https.request calls are automatically traced:
// - Child spans created for outbound calls
// - W3C trace context headers injected
// - Request/response attributes recorded
// - Errors and timeouts captured
// - Breadcrumbs added
```

---

## Transport & Resilience

### Circuit Breaker

Three-state protection against cascading failures:

| State | Behavior |
|-------|----------|
| **CLOSED** | Normal operation — all requests pass through |
| **OPEN** | Endpoint down — all requests skipped (buffered in queue) |
| **HALF_OPEN** | Probing — limited requests to test recovery |

- Failure threshold: 5 consecutive failures → OPEN
- Reset timeout: 30 seconds → transition to HALF_OPEN
- Success in HALF_OPEN → CLOSED

### Rate Limiting

- **Token Bucket**: Smooths burst traffic (capacity: 10, refill: 2/sec)
- **Sliding Window**: Alternative count-based rate limiter

### Retry with Backoff

- Exponential backoff with jitter
- Configurable max retries (default: 3)
- `Retry-After` header support (seconds and HTTP-date)
- `X-RateLimit-Remaining` header awareness

### Compression

| Algorithm | Performance | Ratio |
|-----------|-------------|-------|
| `none` | Fastest | 1:1 (default) |
| `gzip` | Fast | ~3:1 typical |
| `brotli` | Slower | ~4:1 typical |

Compression is automatic — if the compressed payload is larger than the original, it falls back to uncompressed.

### Payload Splitting

If a batch exceeds `maxPayloadBytes`, the sender automatically splits it into smaller chunks and sends them sequentially.

### Memory Safety

- **Event Queue**: Bounded queue with configurable `maxQueueSize`
- **Dead Letter Queue**: Failed events are tracked for observability
- **Ring Buffer**: O(1) breadcrumb storage prevents memory leaks
- **Memory Pressure Monitor**: Polls heap usage, emits events at 70% (elevated) and 90% (critical) thresholds

---

## Plugin System

```typescript
import type { SDKPlugin } from '@vikasbaplawat1/pulse-sdk'

function myPlugin(): SDKPlugin {
  return {
    name: 'my-custom-plugin',

    // Called during SDK init
    setup(context) {
      console.log('Plugin initialized', context.config.service)
    },

    // Transform events before send
    processEvent(event) {
      event.tags = { ...event.tags, source: 'my-plugin' }
      return event // return null to drop
    },

    // Transform breadcrumbs
    processBreadcrumb(breadcrumb) {
      return breadcrumb // return null to drop
    },

    // Last chance to modify/drop before transport
    beforeSend(event) {
      return event
    },

    // Called after successful send
    afterSend(event) {
      metrics.increment('events.sent')
    },

    // Called on transport error
    onTransportError(error, events) {
      alerting.notify('Transport failure', error)
    },

    // Called during SDK shutdown (reverse registration order)
    teardown() {
      cleanup()
    },
  }
}

// Register
await createSDK({
  apiKey: '...',
  plugins: [myPlugin()],
})
```

### Plugin Guarantees

- **Error isolation**: A failing plugin never blocks other plugins or the pipeline
- **Ordered teardown**: Plugins are torn down in reverse registration order
- **Duplicate detection**: Duplicate plugin names are rejected at registration
- **Read-only context**: Plugins receive a frozen config snapshot

---

## Security & PII Scrubbing

Every event passes through deep PII sanitization:

| Pattern | Examples Scrubbed |
|---------|-------------------|
| Email addresses | `user@example.com` → `[EMAIL]` |
| Credit card numbers | `4111-1111-1111-1111` → `[CARD]` |
| Social Security numbers | `123-45-6789` → `[SSN]` |
| Phone numbers | `+1-555-123-4567` → `[PHONE]` |
| Auth tokens | `Bearer eyJ...` → `[TOKEN]` |
| Sensitive keys | `password`, `secret`, `apiKey`, `authorization` → `[REDACTED]` |

### Additional Security

- API keys are **never sent in HTTP headers** — they're embedded in the JSON payload body
- `X-Request-ID` idempotency headers on all requests
- Logger output is PII-redacted (no sensitive data in console.log)
- Header sanitization in Express/Fastify middleware

---

## Event Processing Pipeline

Every captured event flows through a 12-step pipeline:

```
1. Base Fields        ← eventId, timestamp assignment
2. Pre-Init Buffer    ← queue if SDK not yet initialized
3. Feature Gate       ← check enableErrors/enablePerformance/enableMetrics/enableTracing
4. Normalization      ← fill defaults, truncate oversized strings/arrays/objects
5. PII Sanitization   ← deep scrub emails, cards, SSNs, phones, tokens
6. Context Enrichment ← attach trace/span IDs, breadcrumbs from AsyncLocalStorage
7. Plugin processEvent← plugin transform hooks (isolated)
8. Event Processors   ← user-registered transform functions
9. User beforeSend    ← user callback (return null to drop)
10. Plugin beforeSend ← plugin last-chance hooks
11. Sampling          ← random sample based on samplingRate
12. Queue Enqueue     ← bounded memory queue → batcher → transport
```

---

## Public API Reference

### Initialization

| Function | Description |
|----------|-------------|
| `createSDK(options)` | Initialize the SDK (recommended entry point) |
| `init(options)` | Initialize the SDK (alias) |
| `shutdown(timeoutMs?)` | Graceful shutdown with flush |
| `flush()` | Force-flush pending events |
| `getConfig()` | Get resolved SDK configuration |

### Capture

| Function | Description |
|----------|-------------|
| `captureError(error, options?)` | Capture an error with optional severity/fingerprint/context |
| `captureMessage(message, severity?, context?)` | Capture a text message |
| `captureRequest(event)` | Capture a request event |
| `captureEvent(event)` | Capture any event type |
| `captureMetric(name, value, type, options?)` | Capture a metric |
| `incrementCounter(name, tags?)` | Increment a counter metric |
| `setGauge(name, value, tags?)` | Set a gauge metric |
| `recordHistogram(name, value, options?)` | Record a histogram metric |

### Tracing

| Function | Description |
|----------|-------------|
| `startSpan(name, options?)` | Start a new span |
| `withSpan(name, fn, options?)` | Execute async function within a span |
| `withSpanSync(name, fn, options?)` | Execute sync function within a span |
| `getActiveSpan()` | Get the currently active span |
| `flushTracer()` | Force-flush pending spans |
| `extractTraceContext(headers)` | Extract W3C trace context from headers |
| `injectTraceContext(headers, ctx?)` | Inject trace context into headers |
| `parseTraceparent(header)` | Parse a traceparent header string |
| `createTraceparent(traceId, spanId, sampled?)` | Create a traceparent header value |

### Context

| Function | Description |
|----------|-------------|
| `addBreadcrumb(input)` | Add a breadcrumb to the current context |
| `getRequestContext()` | Get the current request context |
| `getTraceId()` | Get the current trace ID |
| `getSpanId()` | Get the current span ID |

### Session

| Function | Description |
|----------|-------------|
| `getSessionManager(options?)` | Get the global session manager |

### Instrumentation

| Function | Description |
|----------|-------------|
| `monitorMiddleware` | Express middleware |
| `fastifyPulsePlugin` | Fastify plugin |
| `instrumentHttpClient()` | Patch http/https for auto-tracing |

### Logger

| Function | Description |
|----------|-------------|
| `setLogger(logger)` | Replace the default logger |
| `getLogger()` | Get the current logger |
| `setDebugMode(enabled)` | Toggle debug logging |

### Types

All types are exported for consumer and plugin author use:

```typescript
// Config
SDKInitOptions, RemoteConfig, ResolvedSDKConfig, TransportOptions

// Events
SDKEvent, RequestEvent, ErrorEvent, MessageEvent, MetricEvent, EventMetadata, StackFrame

// Breadcrumbs
Breadcrumb, BreadcrumbInput, BreadcrumbHint

// Severity
SeverityLevel, Severity, severityFromString

// Plugins
SDKPlugin, PluginMeta, PluginContext, EventProcessor, BreadcrumbProcessor

// Error
CaptureErrorOptions, ParsedError, ErrorGrouping

// Transport
TransportResult, IngestPayload, TransportHealth, TransportAdapter

// Tracing
PulseSpan, SpanStatus, SpanOptions

// Session
Session, SessionManagerOptions
```

---

## Event Payload Format

Every event sent to the ingestion endpoint follows this structure:

```json
{
  "apiKey": "pk_live_...",
  "events": [
    {
      "type": "error",
      "eventId": "a1b2c3d4-...",
      "timestamp": 1715792400000,
      "level": "error",
      "message": "Payment processing failed",
      "fingerprint": "sha256:abc123...",
      "metadata": {
        "sdk": { "name": "@vikasbaplawat1/pulse-sdk", "version": "2.0.0" },
        "runtime": { "name": "node", "version": "v22.0.0" },
        "os": { "name": "linux", "version": "6.1.0" },
        "context": {
          "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
          "spanId": "00f067aa0ba902b7",
          "userId": "user_123",
          "tags": { "team": "payments" }
        }
      },
      "stacktrace": [
        {
          "filename": "services/payment.ts",
          "function": "processPayment",
          "lineno": 42,
          "colno": 15,
          "inApp": true,
          "module": "services/payment"
        }
      ],
      "breadcrumbs": [
        {
          "category": "http",
          "message": "POST /api/charge [200] 142ms",
          "level": "info",
          "timestamp": 1715792399500
        }
      ]
    }
  ]
}
```
