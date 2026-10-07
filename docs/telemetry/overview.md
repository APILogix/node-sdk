# Telemetry Overview

## 1. Unified Telemetry Model

The Pulse Node.js SDK provides a unified telemetry model spanning eight core observability pillars:

1. **Errors & Exceptions (`captureError`):** Captured with complete stack traces, parsed frames, source maps, error classifications, and breadcrumbs.
2. **Distributed Tracing & Spans (`startSpan`, `withSpan`, `wrap`):** High-resolution spans with truthful exclusive CPU time attribution and context propagation.
3. **HTTP Requests (`captureRequest`, `monitorMiddleware`):** Inbound and outbound request/response tracking with status codes, headers, and duration.
4. **Metrics (`captureMetric`, `incrementCounter`, `setGauge`, `recordHistogram`):** High-throughput metric counters and gauges integrated with OpenTelemetry MetricReader.
5. **Structured Logs (`captureLog`):** High-performance log ingestion with severity levels and metadata.
6. **V8 CPU Profiling (`startProfile`, `stopProfile`):** Programmatic V8 CPU sampling profiles.
7. **Cron Heartbeats (`captureCronCheckIn`):** Scheduled job monitoring with status tracking (`in_progress`, `ok`, `error`).
8. **Session Replay (`captureReplay`):** User interaction and event stream capture for debugging.

---

## 2. Public Capture API Reference

All capture functions are exported from the package root ([`src/index.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts)):

```typescript
import {
  captureError,
  captureMessage,
  captureRequest,
  captureEvent,
  captureMetric,
  captureLog,
  captureCronCheckIn,
  captureReplay,
  withSpan,
  incrementCounter,
  setGauge,
} from '@pulse-apm/node';
```

### Signatures & Behavior:

#### `captureError(error: unknown, severity?: SeverityLevel, context?: Record<string, unknown>): string`
- Enqueues an error event with current breadcrumbs, user scope, and parsed stack trace.
- Returns the generated unique `eventId` (UUIDv4).
- Safe with non-Error objects (strings, numbers, null, circular references).

#### `captureMessage(message: string, level?: SeverityLevel, context?: Record<string, unknown>): string`
- Enqueues an informational or warning text message with scope tags.

#### `captureRequest(req: RequestData, res: ResponseData, durationMs: number): void`
- Records an HTTP transaction with sanitized headers and truthful duration breakdown.

#### `captureMetric(name: string, value: number, attributes?: Record<string, string>): void`
- Records an ad-hoc metric sample directly into the in-memory metric registry.

#### `captureCronCheckIn(options: CronCheckInOptions): string`
- Tracks the start, success, or failure of a scheduled task.

---

## 3. Telemetry Guarantees

- **Zero Hot-Path Synchronous I/O:** Calling any capture API pushes an event record to the in-memory queue in under 10 microseconds. Network transmission is always asynchronous and decoupled.
- **Fail-Safe Parameter Handling:** Malformed payloads, circular references, and undefined properties are safely scrubbed and normalized without throwing exceptions.
- **Priority Preservation:** Critical events (fatal errors, crash traces) receive admission priority over high-volume routine logs or metrics.
