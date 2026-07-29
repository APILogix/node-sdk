# SDK event types

`SDKEvent` is the discriminated union of ten event types. Every transported event receives an `eventId` and canonical metadata in the event pipeline. Route URLs are supplied by remote configuration, but the path is forced to the route shown below.

## Authoritative metadata

Every outgoing event has this SDK-owned metadata snapshot:

| Field | Meaning |
|---|---|
| `applicationName` | Consuming package name or explicit init override |
| `applicationVersion` | Consuming package version or explicit init override |
| `sdkName` | SDK package identity from build constants |
| `sdkVersion` | SDK version from build constants |
| `service` | Logical service name |
| `environment` | Deployment environment |
| `release` | Deployment release, separate from package version |
| `serverName` | Optional server identity |

After processors and `beforeSend`, the pipeline replaces `metadata` with the immutable client snapshot. Callers and plugins therefore cannot authoritatively override `applicationName`, `applicationVersion`, `sdkName`, or `sdkVersion` per event.


Metadata resolution at initialization is:

- `applicationName`: init override → discovered `package.json.name` → `service` → `unknown-application`.
- `applicationVersion`: init override → discovered `package.json.version` → `release` → `0.0.0-unknown`.
- `service`: init `service` → resolved application name.
- `release`: init `release` → resolved application version.
- `sdkName` and `sdkVersion`: build constants, not caller input.

`eventId` is optional on caller input and assigned by the pipeline when absent. A missing numeric `timestamp` is also filled during base normalization, although callers should supply required timestamps in typed events. Internal lifecycle fields are removed before transport.

## Route summary

| # | Event discriminator | Route | Forced path |
|---:|---|---|---|
| 1 | `request` | `requests` | `/v1/requests` |
| 2 | `error` | `errors` | `/v1/errors` |
| 3 | `message` | `errors` | `/v1/errors` |
| 4 | `metric` | `metrics` | `/v1/metrics` |
| 5 | `span` | `traces` | `/v1/traces` |
| 6 | `trace` | `traces` | `/v1/traces` |
| 7 | `log` | `logs` | `/v1/logs` |
| 8 | `profile` | `profiles` | `/v1/profiles` |
| 9 | `replay` | `replays` | `/v1/replays` |
| 10 | `cron_checkin` | `crons` | `/v1/checkins` |

There is no generic custom-events route in the active `RouteRegistry`, even though the remote transport compatibility type still contains an `events` route. `captureEvent()` must receive one of the ten recognized discriminators.

## 1. RequestEvent

A completed HTTP request/response observation.

**Required fields**

| Field | Type | Meaning |
|---|---|---|
| `type` | `'request'` | Discriminator |
| `requestId` | `string` | Request correlation ID |
| `url` | `string` | Prefer a normalized route rather than a secret-bearing raw URL |
| `method` | `string` | HTTP method; normalization uppercases it |
| `statusCode` | `number` | Response status |
| `latency` | `number` | Duration in milliseconds in built-in middleware |
| `timestamp` | `number` | Epoch milliseconds |

**Optional fields:** `eventId`, `headers`, `query`, `body`, `bodySize`, `responseSize`, `userId`, `tenantId`, `sessionId`, `clientIp`, `userAgent`, `referer`, `route`, `traceId`, `spanId`, and `metadata`.

Express/Fastify middleware applies privacy capture decisions before attaching headers/query/body, resolves trusted client IP, and correlates active context. `captureRequest()` fills active trace/span IDs only when the caller omitted them.

## 2. ErrorEvent

A captured exception or error-like value.

**Required fields**

| Field | Type | Meaning |
|---|---|---|
| `type` | `'error'` | Discriminator |
| `message` | `string` | Scrubbed error message |
| `name` | `string` | Error class/name |
| `stack` | `StackFrame[]` | Parsed stack frames |
| `fingerprint` | `string` | Grouping key |
| `timestamp` | `number` | Epoch milliseconds |
| `severity` | `debug \| info \| warning \| error \| fatal` | Severity |
| `context` | `Record<string, unknown>` | Capture context |

**Optional fields:** `eventId`, `requestId`, `breadcrumbs`, `traceId`, `spanId`, `mechanism`, and `metadata`.

A `StackFrame` has required `filename`, `function`, and `inApp`, with optional line/column, module, and source context (`pre`, `line`, `post`). `mechanism` identifies paths such as `manual`, `uncaughtException`, `unhandledRejection`, `console.error`, or framework capture.

The transport queue's critical flag is narrower than the route priority: only a fatal error receives critical eviction protection.

## 3. MessageEvent

A core text observation, distinct from a structured log.

**Required fields:**

- `type: 'message'`
- `message: string`
- `severity: SeverityLevel`
- `timestamp: number`

**Optional fields:** `eventId`, `context`, `breadcrumbs`, `traceId`, `spanId`, and `metadata`.

Messages share `/v1/errors` with errors but are not error stack/fingerprint records. They are not controlled by the optional logging entitlement.

## 4. MetricEvent

A metric sample or aggregate.

**Required fields**

| Field | Type | Meaning |
|---|---|---|
| `type` | `'metric'` | Discriminator |
| `metricName` | `string` | Metric identity |
| `metricType` | `'counter' \| 'gauge' \| 'histogram'` | Metric family |
| `value` | `number` | Sample/current value |
| `timestamp` | `number` | Epoch milliseconds |

**Optional identity fields:** `eventId`, `unit`, `tags`, and `metadata`.

**Optional aggregate fields:** `count`, `sum`, `min`, `max`, `p50`, `p75`, `p90`, `p95`, `p99`, `avg`, and `rate`.

Public metric helpers normally record through the bounded metrics registry before emitted aggregates become events. Names and tags should have controlled cardinality and must not contain secrets.

## 5. SpanEvent

A finished OpenTelemetry span converted to Pulse format.

**Required fields**

| Field | Type | Meaning |
|---|---|---|
| `type` | `'span'` | Discriminator |
| `spanId`, `traceId` | `string` | Trace identity |
| `name` | `string` | Operation name |
| `startTime`, `endTime`, `duration` | `number` | Millisecond timing |
| `status` | `'ok' \| 'error' \| 'unset'` | Completion status |

**Optional fields:** `eventId`, `timestamp`, `requestId`, `sessionId`, `userId`, `tenantId`, `parentSpanId`, `kind`, `exclusiveDuration`, `statusMessage`, `attributes`, `events`, `links`, and `metadata`.

`kind` can be `internal`, `server`, `client`, `producer`, or `consumer`. A span event item contains `name`, `timestamp`, and optional attributes. A link contains `traceId` and `spanId` in the public event type; exported links can also originate with relationship attributes in manual span options.

Span events are produced by the custom pipeline exporter, not an OTLP exporter. Attribute capture and limits are applied before routing.

## 6. TraceEvent

An aggregated trace document with an embedded span tree.

**Required fields**

| Field | Type | Meaning |
|---|---|---|
| `type` | `'trace'` | Discriminator |
| `traceId` | `string` | Trace identity |
| `rootSpan` | `AggregatedSpanEvent` | Reconstructed hierarchy root |
| `spanCount` | `number` | Number of aggregated spans |
| `totalDuration` | `number` | Aggregate/root duration |
| `isPartial` | `boolean` | Root was missing or trace was incomplete |

**Optional fields:** `eventId`, `timestamp`, `metadata`, `requestId`, `sessionId`, `userId`, and `tenantId`.

Each `AggregatedSpanEvent` includes span identity, timing, status, optional kind/status message/exclusive duration/attributes/events/links, and recursive `children`. Trace events are generally produced by the trace aggregator rather than hand-authored application code.

## 7. LogEvent

A structured explicit or intercepted log entry.

**Required fields:**

- `type: 'log'`
- `level: string`
- `message: string`
- `timestamp: number`

**Optional fields:** `eventId`, `args`, `requestId`, `traceId`, `spanId`, and `metadata`.

The public helper accepts SDK severity names plus `warn` and `log`, normalizing those aliases to `warning` and `info`. A fatal log receives critical queue eviction preference; other levels do not.

## 8. ProfileEvent

A CPU or heap profile payload.

**Required fields**

| Field | Type | Meaning |
|---|---|---|
| `type` | `'profile'` | Discriminator |
| `profileType` | `'cpu' \| 'heap'` | Payload category |
| `startTime`, `endTime`, `duration` | `number` | Profile interval |
| `profile` | `unknown` | Profiler-specific payload |
| `timestamp` | `number` | Epoch milliseconds |

**Optional fields:** `eventId`, `requestId`, `traceId`, `spanId`, and `metadata`.

The public manual profile API currently starts/stops CPU profiling. The event schema's heap discriminator does not by itself establish a public manual heap-profile API.

## 9. ReplayEvent

A caller-supplied session replay segment.

**Required fields:**

- `type: 'replay'`
- `sessionId: string`
- `segmentId: number`
- `timestamp: number`
- `events: readonly unknown[]`

**Optional fields:** `eventId` and `metadata`.

`segmentId` is documented as monotonically increasing within a session, but the capture helper does not promise cross-process ordering enforcement. Empty session IDs or empty event arrays are ignored. Replay entries are recursively scrubbed before transport.

## 10. CronCheckInEvent

A scheduled-job state transition.

**Required fields:**

- `type: 'cron_checkin'`
- `monitorSlug: string`
- `status: 'ok' | 'error' | 'in_progress'`
- `timestamp: number`

**Optional fields:** `eventId`, `duration`, `environment`, and `metadata`.

`duration` is milliseconds in the public API. The subsystem fills environment from canonical metadata when no override is given. A failed check-in receives critical queue eviction preference. The route sends batches of one with no wait.

## Processing fields shared across events

### IDs and timestamps

The pipeline preserves a caller-provided string `eventId`; otherwise it generates one. Stable IDs are retained through in-memory retry, persistence, and replay and are the receiver's deduplication key. The SDK guarantees neither exactly-once delivery nor globally ordered delivery across routes.

### Correlation

Depending on the event interface and active context, the SDK can attach `requestId`, `traceId`, `spanId`, `sessionId`, `userId`, and `tenantId`. Scope enrichment can add top-level `user`, `tags`, `extra`, and `contexts` even though those extension fields are not declared on every narrow event interface.

### Metadata trust boundary

Callers may include `metadata` in a typed event, and internal span/cron producers create preliminary metadata, but the canonical pipeline overwrites it after all user/plugin processing. The authoritative values are therefore:

```text
applicationName
applicationVersion
sdkName
sdkVersion
service
environment
release
serverName? (when supplied by the client metadata snapshot)
```

This protects package and SDK identity from per-event spoofing. It does not make other event fields trusted; processors can transform non-metadata fields and the backend should validate every payload.

### Privacy and size

Normalization, limits, security scrubbing, PII masking, processor filtering, and transport payload caps can alter or drop an event. Large batches are split until they fit; a single oversized event is dropped. A successful local receipt is not evidence that the final event shape was delivered.