# Backend Event Types — sdk-node

> **Status:** Event catalog is current as of the latest hardening pass. See [`FIXES.md`](./FIXES.md) for entitlement and compression changes that affect this contract.

This document catalogues every event type emitted by the SDK, the route it travels on, the compression applied, and the shape of the payload delivered to the backend.

## Event Type Summary

| Type | Route | Priority | Remote-Config Gating | Notes |
|------|-------|----------|----------------------|-------|
| `error` | `errors` | high | `killswitches.disableErrors`, `sampling.errors` | Core API; always available |
| `message` | `errors` | high | `killswitches.disableErrors` | Captured via `captureMessage()`; currently shares errors route |
| `span` | `traces` | normal | Entitlement `customSpans`, `sampling.traces` | OpenTelemetry-compatible spans |
| `metric` | `metrics` | low | Entitlement `customMetrics`, `sampling.metrics` | Counters, gauges, histograms |
| `log` | `logs` | normal | Entitlement `logging`, `killswitches.disableLogs` | Application logs |
| `profile` | `profiles` | low | Entitlement `profiling`, `sampling.profiles` | CPU profiles / wall-time profiles |
| `replay` | `replays` | low | Entitlement `sessionReplay`, `sampling.replays` | Session replay segments |
| `cron_checkin` | `crons` | high | Entitlement `crons` | Heartbeat / start / finish |
| `request` | `requests` | normal | `killswitches.disableRequests`, request sampling | HTTP request/response telemetry |
| `breadcrumb` | embedded | n/a | n/a | Attached to `error`/`request` events; never sent standalone |

## Payload Format (per batch)

Every batch is sent to the route-specific URL with:

```http
POST /<route-endpoint>
Content-Type: application/json
Content-Encoding: gzip
Authorization: Bearer <apiKey>
X-Route: <enterpriseRoute>
x-pulse-internal: 1
```

The uncompressed body shape is:

```json
{
  "events": [ /* SDKEvent objects */ ],
  "route": "errors",
  "timestamp": 1712345678901
}
```

The body is gzip-compressed as a `Buffer` / `Uint8Array` before the network request.

## Event Type Schemas

### `ErrorEvent`

```ts
interface ErrorEvent extends BaseEvent {
  type: 'error'
  message: string          // scrubbed before transport
  name: string
  stack: StackFrame[]
  fingerprint: string
  severity: SeverityLevel
  context?: Record<string, unknown>
  mechanism?: string
  breadcrumbs?: Breadcrumb[]
  requestId?: string
  traceId?: string
  spanId?: string
}
```

Backend route: `errors`  
Sent via: `BatchManager` / `MultiplexedTransport`

### `MessageEvent`

```ts
interface MessageEvent extends BaseEvent {
  type: 'message'
  message: string          // scrubbed before transport
  level: 'info' | 'warning' | 'error' | 'debug'
  timestamp: number
  context?: Record<string, unknown>
}
```

Backend route: `errors` (shared)  
Sent via: `BatchManager`

### `SpanEvent`

```ts
interface SpanEvent extends BaseEvent {
  type: 'span'
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer'
  startTime: number
  endTime: number
  status?: { code: 'OK' | 'ERROR'; message?: string }
  attributes?: Record<string, unknown>
  events?: SpanEvent[]      // nested span events / annotations
  links?: SpanLink[]
  __pulseInternal?: { /* SDK internal metadata */ }
}
```

Backend route: `traces`  
Sent via: `BatchManager` / `MultiplexedTransport`  
Gated by: `entitlements.customSpans` and `sampling.traces`

### `MetricEvent`

```ts
interface MetricEvent extends BaseEvent {
  type: 'metric'
  name: string
  metricType: 'counter' | 'gauge' | 'histogram'
  value: number
  labels?: Record<string, string>
  timestamp: number
  // Legacy percentile fields are no longer computed by the SDK
  // and should be treated as deprecated by the backend.
  p50?: number
  p95?: number
  p99?: number
}
```

Backend route: `metrics`  
Sent via: `BatchManager`  
Gated by: `entitlements.customMetrics` and `sampling.metrics`

### `LogEvent`

```ts
interface LogEvent extends BaseEvent {
  type: 'log'
  message: string
  level: string
  timestamp: number
  attributes?: Record<string, unknown>
  traceId?: string
  spanId?: string
}
```

Backend route: `logs`  
Sent via: `BatchManager`  
Gated by: `entitlements.logging` and `killswitches.disableLogs`

### `ProfileEvent`

```ts
interface ProfileEvent extends BaseEvent {
  type: 'profile'
  profileType: 'cpu' | 'wall' | 'memory'
  data: string | Uint8Array
  timestamp: number
  duration: number
  threadName?: string
}
```

Backend route: `profiles`  
Sent via: `BatchManager`  
Gated by: `entitlements.profiling` and `sampling.profiles`

### `ReplayEvent`

```ts
interface ReplayEvent extends BaseEvent {
  type: 'replay'
  segmentId: string
  sessionId: string
  data: string | Uint8Array
  timestamp: number
}
```

Backend route: `replays`  
Sent via: `BatchManager`  
Gated by: `entitlements.sessionReplay` and `sampling.replays`

### `CronCheckInEvent`

```ts
interface CronCheckInEvent extends BaseEvent {
  type: 'cron_checkin'
  monitorId: string
  status: 'in_progress' | 'ok' | 'error'
  timestamp: number
  duration?: number
  environment?: string
}
```

Backend route: `crons`  
Sent via: direct queue (should be normalized to `BatchManager` / event pipeline)  
Gated by: `entitlements.crons`

### `RequestEvent`

```ts
interface RequestEvent extends BaseEvent {
  type: 'request'
  method: string
  url: string
  statusCode: number
  duration: number
  headers?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  bodySize?: number
  clientIp?: string          // hashed when maskIp is true
  userAgent?: string
  requestId?: string
  traceId?: string
  spanId?: string
}
```

Backend route: `requests`  
Sent via: `BatchManager`  
Gated by: `killswitches.disableRequests`, request sampling, and capture gate

### `Breadcrumb`

Never sent as a standalone event. Embedded in `ErrorEvent` and `RequestEvent` under `breadcrumbs`.

```ts
interface Breadcrumb {
  type: string
  message: string
  timestamp: number
  data?: Record<string, unknown>
}
```

## Compression Contract

- **Every batch is gzip-compressed before transmission.** This is an SDK-level transport contract, not a remote-config knob.
- The backend must accept `Content-Encoding: gzip` and decompress the body.
- Compression is applied per batch, not per event, and not only when the remote SDK enables it.
- Cron check-ins, errors, and immediate-flush routes also use gzip (the buffer is still compressed before the HTTP request).

## Delivery Guarantees

- At-least-once delivery: failed batches are re-queued and optionally persisted to disk.
- Backend deduplication is expected by `eventId`.
- Batches over `maxPayloadBytes` are split; single oversized events are dropped.

## Known Issues

- `MetricEvent.p50/p95/p99` are emitted by type but no longer populated by the SDK; backend should not rely on them.  
  **Status:** Documented.
- `SpanLink.attributes` is present in emitted data but missing from the TypeScript interface; type should be updated.  
  **Status:** Documented.
- `cron_checkin` currently bypasses the standard event pipeline and scrubbing; fix in progress.  
  **Status:** Fixed — cron check-ins now flow through the event pipeline.
