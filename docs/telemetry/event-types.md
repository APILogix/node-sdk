# Event Schemas & Types

## 1. Overview

All telemetry records emitted by `@pulse-apm/node` conform to strict TypeScript interfaces defined in [`src/types/event.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/event.ts).

---

## 2. Common Event Metadata

Every event inherits standard environmental and process metadata:

```typescript
export interface EventMetadata {
  eventId: string;              // UUIDv4
  timestamp: string;            // ISO 8601 UTC
  timestampMonotonicMs: number; // process.hrtime() high-resolution offset
  projectId: string;
  environment: string;          // e.g. "production", "staging"
  release: string;              // e.g. "1.0.4"
  sdk: {
    name: string;               // "@pulse-apm/node"
    version: string;            // "8.4.5"
    runtime: "node";
    runtimeVersion: string;     // e.g. "v20.11.0"
  };
  host?: {
    hostname: string;
    architecture: string;
    platform: string;
  };
  tags?: Record<string, string>;
  user?: {
    id?: string;
    email?: string;
    username?: string;
  };
}
```

---

## 3. Concrete Event Schemas

### 3.1 Error Event (`ErrorEvent`)
```typescript
export interface ErrorEvent extends EventMetadata {
  type: 'error';
  level: 'fatal' | 'error' | 'warning' | 'info';
  error: {
    name: string;
    message: string;
    stack?: string;
    frames?: StackFrame[];
    fingerprint?: string;
    mechanism?: {
      type: string;
      handled: boolean;
    };
  };
  breadcrumbs?: Breadcrumb[];
  traceId?: string;
  spanId?: string;
}
```

### 3.2 Trace & Span Event (`TraceEvent`, `SpanEvent`)
```typescript
export interface SpanEvent {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  exclusiveDurationMs: number; // Truthful CPU time exclusive of child operations
  status: {
    code: 'unset' | 'ok' | 'error';
    message?: string;
  };
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timestampMs: number; attributes?: Record<string, unknown> }>;
  links?: Array<{ traceId: string; spanId: string }>;
}
```

### 3.3 HTTP Request Event (`RequestEvent`)
```typescript
export interface RequestEvent extends EventMetadata {
  type: 'request';
  http: {
    method: string;
    url: string;
    route?: string;
    statusCode: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    clientIp?: string;
  };
  durationMs: number;
  traceId?: string;
  spanId?: string;
}
```

### 3.4 Metric Event (`MetricEvent`)
```typescript
export interface MetricEvent extends EventMetadata {
  type: 'metric';
  metrics: Array<{
    name: string;
    type: 'counter' | 'gauge' | 'histogram' | 'up_down_counter';
    value: number;
    unit?: string;
    attributes?: Record<string, string>;
  }>;
}
```

### 3.5 Log Event (`LogEvent`)
```typescript
export interface LogEvent extends EventMetadata {
  type: 'log';
  message: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  logger?: string;
  attributes?: Record<string, unknown>;
}
```

### 3.6 Cron Check-In Event (`CronCheckInEvent`)
```typescript
export interface CronCheckInEvent extends EventMetadata {
  type: 'cron';
  monitorSlug: string;
  status: 'in_progress' | 'ok' | 'error';
  durationMs?: number;
  checkInId?: string;
}
```
