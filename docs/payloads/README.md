# SDK Event Payload Examples

This directory contains complete JSON payload examples for every event type sent by the SDK to the backend.

## All Event Types

| # | Event Type | File | Route | Description |
|---|------------|------|-------|-------------|
| 1 | `request` | [request-event.json](./request-event.json) | `/v1/requests` | HTTP request tracking |
| 2 | `error` | [error-event.json](./error-event.json) | `/v1/errors` | Error/exception tracking |
| 3 | `message` | [message-event.json](./message-event.json) | `/v1/errors` | Log messages |
| 4 | `metric` | [metric-event.json](./metric-event.json) | `/v1/metrics` | Performance metrics |
| 5 | `span` | [span-event.json](./span-event.json) | `/v1/traces` | Individual distributed tracing span |
| 6 | `trace` | [trace-event.json](./trace-event.json) | `/v1/traces` | Aggregated trace with hierarchy |
| 7 | `log` | [log-event.json](./log-event.json) | `/v1/logs` | Console/structured logs |
| 8 | `profile` | [profile-event.json](./profile-event.json) | `/v1/profiles` | CPU/heap profiling data |
| 9 | `replay` | [replay-event.json](./replay-event.json) | `/v1/replays` | Session replay recordings |
| 10 | `cron_checkin` | [cron-checkin-event.json](./cron-checkin-event.json) | `/v1/checkins` | Cron job monitoring |

## Key Points

### ID Format
- **traceId**: 32-character hexadecimal string (e.g., `"4bf92f3577b34da6a3ce929d0e0e4736"`)
- **spanId**: 16-character hexadecimal string (e.g., `"00f067aa0ba902b7"`)
- **eventId**: UUID v4 string (e.g., `"550e8400-e29b-41d4-a716-446655440000"`)
- **parentSpanId**: 16-character hexadecimal string or `null` for root spans

### Timestamps
All timestamps are **epoch milliseconds** (number type), not ISO strings.

Example: `1722528000000` = August 1, 2026 12:00:00 AM UTC

### Common Fields
Every event includes:
- `type` - Event type identifier
- `eventId` - UUID v4 for deduplication
- `timestamp` - Epoch milliseconds
- `metadata` - SDK and application metadata (immutable)

### Metadata Structure
```json
{
  "sdkName": "@pulse/sdk-node",
  "sdkVersion": "1.0.0",
  "applicationName": "my-app",
  "applicationVersion": "2.3.1",
  "projectId": "proj_abc123",
  "environment": "production",
  "release": "v2.3.1",
  "serverName": "web-server-01"
}
```

### Security
Sensitive data is automatically scrubbed:
- Passwords → `"[REDACTED]"`
- Authorization headers → `"[REDACTED]"`
- Credit card numbers → `"[REDACTED]"`
- API keys → `"[REDACTED]"`

## Payload Highlights

### Request Event
- Complete HTTP request/response data
- Query parameters and request body
- Headers (scrubbed)
- Performance metrics (latency, sizes)
- User/session/tenant correlation

### Error Event
- Parsed stack traces with source context
- Breadcrumb trail (event history)
- Fingerprinting for grouping
- Trace correlation (traceId, spanId)

### Span Event
- OpenTelemetry span data
- **parentSpanId** for hierarchy
- Attributes (HTTP, DB, custom)
- Events and links
- Exclusive duration calculation

### Trace Event
- Complete span hierarchy tree
- **Nested children with parentSpanId**
- Root span identification
- Aggregated metrics

## Batch Transport Format

Events are sent in batches:

```json
{
  "events": [
    { "type": "request", ... },
    { "type": "error", ... },
    { "type": "span", ... }
  ],
  "route": "requests",
  "timestamp": 1722528000000
}
```

## Usage

These JSON files can be used for:
1. **Backend development** - Expected payload schemas
2. **Testing** - Mock data for integration tests
3. **Documentation** - API contract reference
4. **Validation** - Schema validation rules

## Related Documentation

- **Full Specification**: [EVENT_PAYLOAD_SPECIFICATION.md](../EVENT_PAYLOAD_SPECIFICATION.md)
- **Span Audit**: [SPAN_PROPAGATION_AUDIT.md](../SPAN_PROPAGATION_AUDIT.md)
- **Summary**: [SDK_EVENT_PAYLOADS_SUMMARY.md](../../docs/SDK_EVENT_PAYLOADS_SUMMARY.md)
