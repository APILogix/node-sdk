# Event Schemas & Types Catalog

> **Authoritative Specification**: Synchronized with [`src/types/event.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/event.ts)  
> **Node.js SDK Architecture**: Pure Backend Observability (All 9 Canonical Telemetry Types)

---

## 1. Event Type Overview

The Pulse Node.js SDK normalizes all captured telemetry into **9 canonical event models**:

| Event Type (`type`) | Interface | Ingestion Route | Generation Trigger | Primary Telemetry Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **`request`** | `RequestEvent` | `/v1/requests` | Express / Fastify / HTTP client hooks or `captureRequest()` | Inbound HTTP transaction performance, status codes, route latency |
| **`error`** | `ErrorEvent` | `/v1/errors` | `uncaughtException`, `unhandledRejection`, `captureException()` | Crash forensics, parsed call stacks, source maps, breadcrumbs |
| **`message`** | `MessageEvent` | `/v1/events` | `captureMessage(message, level, context)` | Operational text messages, warnings, and diagnostic notes |
| **`metric`** | `MetricEvent` | `/v1/metrics` | `incrementCounter()`, `setGauge()`, `recordHistogram()` | High-throughput numerical metric counts, gauges, histograms |
| **`span`** | `SpanEvent` | `/v1/spans` | `withSpan()`, `startSpan()`, `withDbSpan()` | Individual units of execution within a distributed trace |
| **`trace`** | `TraceEvent` | `/v1/traces` | `TraceAggregator` (root span completion) | Full hierarchical trace waterfall with embedded span trees |
| **`log`** | `LogEvent` | `/v1/logs` | `captureLog(level, message, context)` | Structured application log forwarding with trace correlation |
| **`profile`** | `ProfileEvent` | `/v1/profiles` | `startProfile()`, `stopProfile()` | V8 CPU execution profiles and heap allocation graphs |
| **`cron_checkin`** | `CronCheckInEvent` | `/v1/crons` | `captureCronCheckIn(monitorSlug, status, options)` | Scheduled job heartbeat check-ins and execution duration |

---

## 2. Common Event Metadata (`EventMetadata`)

Attached automatically to all events during Stage 2 of the SDK pipeline:

```typescript
export interface EventMetadata {
  readonly sdkName: string           // e.g. "@lynktrace/node"
  readonly sdkVersion: string        // e.g. "0.1.0-beta.1"
  readonly applicationName: string   // package.json name or override
  readonly applicationVersion: string// package.json version
  readonly projectId: string         // Authoritative backend project ID
  readonly environment: string       // "production", "staging", "development"
  readonly release: string           // Git SHA, Docker tag, or release slug
  readonly serverName?: string       // Hostname or container ID
}
```

---

## 3. Concrete Event Schemas

### 3.1 Request Event (`RequestEvent`)
```typescript
export interface RequestEvent {
  readonly type: 'request'
  eventId?: string
  readonly requestId: string
  readonly url: string
  readonly method: string
  readonly statusCode: number
  readonly latency: number
  readonly timestamp: number
  readonly headers?: Readonly<Record<string, unknown>>
  readonly query?: Readonly<Record<string, unknown>>
  readonly body?: Readonly<Record<string, unknown>>
  readonly bodySize?: number
  readonly responseSize?: number
  readonly userId?: string | null
  readonly tenantId?: string
  readonly sessionId?: string
  readonly clientIp?: string
  readonly userAgent?: string
  readonly route?: string
  readonly traceId?: string
  readonly spanId?: string
  readonly metadata?: EventMetadata
}
```

### 3.2 Error Event (`ErrorEvent`)
```typescript
export interface ErrorEvent {
  readonly type: 'error'
  eventId?: string
  readonly requestId?: string
  readonly message: string
  readonly name: string
  readonly stack: readonly StackFrame[]
  readonly fingerprint: string
  readonly timestamp: number
  readonly severity: SeverityLevel
  readonly statusCode?: number
  readonly handled?: boolean
  readonly route?: string
  readonly url?: string
  readonly context: Readonly<Record<string, unknown>>
  readonly breadcrumbs?: readonly Breadcrumb[]
  readonly traceId?: string
  readonly spanId?: string
  readonly mechanism?: ErrorMechanism | string
  readonly classification?: ErrorClassification
  readonly metadata?: EventMetadata
}
```

### 3.3 Message Event (`MessageEvent`)
```typescript
export interface MessageEvent {
  readonly type: 'message'
  eventId?: string
  readonly message: string
  readonly severity: SeverityLevel
  readonly timestamp: number
  readonly context?: Readonly<Record<string, unknown>>
  readonly breadcrumbs?: readonly Breadcrumb[]
  readonly traceId?: string
  readonly spanId?: string
  readonly metadata?: EventMetadata
}
```

### 3.4 Metric Event (`MetricEvent`)
```typescript
export interface MetricEvent {
  readonly type: 'metric'
  eventId?: string
  readonly metricName: string
  readonly metricType: 'counter' | 'gauge' | 'histogram'
  readonly value: number
  readonly unit?: string
  readonly tags?: Readonly<Record<string, string>>
  readonly timestamp: number
  readonly count?: number
  readonly sum?: number
  readonly min?: number
  readonly max?: number
  readonly p50?: number
  readonly p75?: number
  readonly p90?: number
  readonly p95?: number
  readonly p99?: number
  readonly metadata?: EventMetadata
}
```

### 3.5 Span Event (`SpanEvent`)
```typescript
export interface SpanEvent {
  readonly type: 'span'
  eventId?: string
  readonly spanId: string
  readonly traceId: string
  readonly parentSpanId?: string
  readonly name: string
  readonly kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer'
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly exclusiveDuration?: number
  readonly status: 'ok' | 'error' | 'unset'
  readonly statusMessage?: string
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly events?: readonly SpanEventItem[]
  readonly links?: readonly SpanLink[]
  readonly metadata?: EventMetadata
}
```

### 3.6 Trace Event (`TraceEvent`)
```typescript
export interface TraceEvent {
  readonly type: 'trace'
  eventId?: string
  readonly traceId: string
  readonly rootSpan: AggregatedSpanEvent
  readonly spanCount: number
  readonly totalDuration: number
  readonly isPartial: boolean
  readonly metadata?: EventMetadata
}
```

### 3.7 Log Event (`LogEvent`)
```typescript
export interface LogEvent {
  readonly type: 'log'
  eventId?: string
  readonly level: string
  readonly message: string
  readonly timestamp: number
  readonly args?: readonly unknown[]
  readonly requestId?: string
  readonly traceId?: string
  readonly spanId?: string
  readonly metadata?: EventMetadata
}
```

### 3.8 Profile Event (`ProfileEvent`)
```typescript
export interface ProfileEvent {
  readonly type: 'profile'
  eventId?: string
  readonly profileType: 'cpu' | 'heap'
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly profile: unknown
  readonly timestamp: number
  readonly isContinuous?: boolean
  readonly sampleRateHz?: number
  readonly activeTraceIds?: readonly string[]
  readonly metadata?: EventMetadata
}
```

### 3.9 Cron Check-In Event (`CronCheckInEvent`)
```typescript
export interface CronCheckInEvent {
  readonly type: 'cron_checkin'
  eventId?: string
  readonly monitorSlug: string
  readonly status: 'ok' | 'error' | 'in_progress'
  readonly timestamp: number
  readonly duration?: number
  readonly environment?: string
  readonly metadata?: EventMetadata
}
```
