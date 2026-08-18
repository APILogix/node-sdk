# ERROR Event Status Code Analysis

**Date:** 2026-08-02  
**Question:** Does the SDK send error status codes with ERROR events?  
**Answer:** ❌ **NO** - The SDK does NOT send any status code field with ERROR events

---

## Executive Summary

After comprehensive analysis of the SDK source code and production data, I can confirm:

1. **ERROR events (type: 'error') do NOT have a `status` field**
2. **ERROR events do NOT have a `statusCode` field**
3. **ERROR events only have a `severity` field** (info, warning, error, fatal)

### What ERROR Events DO Have

```typescript
interface ErrorEvent {
  readonly type: 'error'
  eventId?: string
  readonly requestId?: string | undefined
  readonly message: string
  readonly name: string
  readonly stack: readonly StackFrame[]
  readonly fingerprint: string
  readonly timestamp: number
  readonly severity: SeverityLevel           // ✅ This is what errors have
  readonly context: Readonly<Record<string, unknown>>
  readonly breadcrumbs?: readonly Breadcrumb[] | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly mechanism?: string | undefined
  readonly metadata?: EventMetadata | undefined
}
```

---

## Analysis Details

### 1. Source Code Analysis

**File:** `sdk-node/src/capture/captureError.ts:137-151`

```typescript
const event: ErrorEvent = {
  type: 'error',
  message: safeMessage,
  name: normalized.name,
  stack: stackFrames,
  fingerprint,
  severity,                    // ✅ severity field
  timestamp: epochMs(),
  context,
  mechanism,
  breadcrumbs,
  requestId: ctx?.requestId,
  traceId: getTraceId(),
  spanId: getSpanId(),
}
```


**No `status` or `statusCode` field is created.**

### 2. Type Definition

**File:** `sdk-node/src/types/event.ts:64-85`

```typescript
export interface ErrorEvent {
  readonly type: 'error'
  eventId?: string
  readonly requestId?: string | undefined
  readonly message: string
  readonly name: string
  readonly stack: readonly StackFrame[]
  readonly fingerprint: string
  readonly timestamp: number
  readonly severity: SeverityLevel        // ✅ Only severity
  readonly context: Readonly<Record<string, unknown>>
  readonly breadcrumbs?: readonly Breadcrumb[] | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly mechanism?: string | undefined
  readonly metadata?: EventMetadata | undefined
}
```

**No `status` or `statusCode` field exists in the type definition.**

### 3. Production Data Verification

**File:** `cornv2/errors/1785611564585-flkl.json`

```json
{
  "events": [
    {
      "type": "error",
      "message": "Explicit error from /errors/manual",
      "name": "Error",
      "stack": [...],
      "fingerprint": "46faf19643b4b127177859a4dadf55b009ebe41de48afe50860f998deca37d9e",
      "severity": "error",
      "timestamp": 1785611561634,
      "context": {
        "source": "manual-test",
        "requestBody": {}
      },
      "mechanism": "manual",
      "breadcrumbs": [...],
      "requestId": "c708aa61-799e-4aeb-9980-e0d5bcfb5a1d",
      "eventId": "ee930769-b2b7-40c0-9fe6-7938358e2c75"
    }
  ]
}
```

**Fields present:**
- ✅ `severity: "error"`
- ❌ No `status` field
- ❌ No `statusCode` field


---

## Confusion Points

### Status vs Severity

| Event Type | Field Name | Values | Purpose |
|------------|------------|--------|---------|
| **ERROR** (type: 'error') | `severity` | "info", "warning", "error", "fatal" | Error importance level |
| **SPAN** (type: 'span') | `status` | "ok", "error", "unset" | Operation completion status |
| **REQUEST** (type: 'request') | `statusCode` | 200, 404, 500, etc. | HTTP response status |

### Where Status Codes DO Appear

1. **REQUEST Events** - Have `statusCode` field (HTTP status: 200, 404, 500)
2. **SPAN Events** - Have `status` field ('ok', 'error', 'unset')
3. **ERROR Events** - Have NEITHER, only `severity`

---

## Could HTTP Status Codes Be in Context?

Users might add HTTP status codes to the `context` object, but the SDK doesn't do this automatically.

### Manual Addition (Possible)

```javascript
PulseSDK.captureError(new Error('Payment failed'), {
  context: {
    httpStatusCode: 402,  // ⚠️ User-provided, not SDK standard
    endpoint: '/api/payment'
  }
})
```

### What Gets Sent

```json
{
  "type": "error",
  "severity": "error",
  "context": {
    "httpStatusCode": 402,  // User-added
    "endpoint": "/api/payment"
  }
}
```

**This is not a standard SDK field** - it's just arbitrary context data the user provided.

---

## Related: When DOES the SDK Use Status?

### 1. SPAN Events Have `status`


**File:** `sdk-node/src/tracing/tracer.ts:330` (spanToEvent method)

```typescript
const statusLabel = status.code === 0 ? 'unset' : status.code === 1 ? 'ok' : 'error'

return {
  type: 'span',
  spanId: ctx.spanId,
  traceId: ctx.traceId,
  status: statusLabel,  // ✅ Spans have status
  // ...
}
```

### 2. REQUEST Events Have `statusCode`

**File:** `sdk-node/src/types/event.ts:38-58`

```typescript
export interface RequestEvent {
  readonly type: 'request'
  eventId?: string
  readonly requestId: string
  readonly url: string
  readonly method: string
  readonly statusCode: number  // ✅ HTTP status code
  readonly latency: number
  readonly timestamp: number
  // ...
}
```

### 3. ERROR Events Have `severity` (Not Status)

**File:** `sdk-node/src/types/event.ts:64-85`

```typescript
export interface ErrorEvent {
  readonly type: 'error'
  // ...
  readonly severity: SeverityLevel  // ✅ info, warning, error, fatal
  // ...
}
```

---

## Comprehensive Field Comparison

```typescript
// ❌ ERROR Event - NO status/statusCode
{
  type: "error",
  severity: "error",           // ✅ This is what errors use
  message: "Something failed",
  name: "Error",
  stack: [...]
}

// ✅ SPAN Event - Has status
{
  type: "span",
  status: "error",             // ✅ ok, error, unset
  statusMessage: "Operation failed",
  duration: 123
}

// ✅ REQUEST Event - Has statusCode
{
  type: "request",
  statusCode: 500,             // ✅ HTTP status code
  method: "POST",
  url: "/api/payment"
}
```


---

## FAQ

### Q: Why don't error events have status codes?

**A:** Error events represent application exceptions and crashes, not HTTP responses. They use `severity` to indicate importance (info → warning → error → fatal). HTTP status codes are only relevant for REQUEST events.

### Q: If an HTTP request fails, where is the status code?

**A:** 
- The HTTP status code is in the **REQUEST event** (type: 'request')
- The error details are in the **ERROR event** (type: 'error')
- They are correlated via the same `requestId`

**Example:**

```json
// REQUEST Event
{
  "type": "request",
  "requestId": "abc-123",
  "statusCode": 500,
  "url": "/api/payment"
}

// ERROR Event (same request)
{
  "type": "error",
  "requestId": "abc-123",
  "severity": "error",
  "message": "Payment gateway timeout"
}
```

### Q: Can I add HTTP status to error context?

**A:** Yes, but it's not a standard field:

```javascript
PulseSDK.captureError(error, {
  context: {
    httpStatus: 402  // Custom field
  }
})
```

This is just arbitrary context data, not a standardized SDK field.

### Q: What about span status when an error occurs?

**A:** When `captureError()` is called with an active span:

1. The span's `status` is set to "error" (OpenTelemetry span status)
2. The error is recorded as an exception event in the span's `events` array
3. A separate ERROR event is also emitted

**Code:** `sdk-node/src/capture/captureError.ts:80-82`

```typescript
if (activeSpan) {
  activeSpan.recordException(normalized)
  activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
}
```


---

## Conclusion

### ❌ ERROR Events Do NOT Have

- `status` field
- `statusCode` field
- Any HTTP status information (unless manually added to context)

### ✅ ERROR Events DO Have

- `severity` field (info, warning, error, fatal)
- `mechanism` field (how error was captured)
- `context` object (arbitrary user data)
- `requestId` (for correlation with REQUEST events)
- `traceId` / `spanId` (for correlation with tracing)

### Summary Table

| Question | Answer |
|----------|--------|
| Does ERROR event have `status`? | ❌ NO |
| Does ERROR event have `statusCode`? | ❌ NO |
| Does ERROR event have `severity`? | ✅ YES |
| Where is HTTP status code? | REQUEST event (`statusCode` field) |
| Where is span status? | SPAN event (`status` field) |

---

## Source Code References

1. **Error Capture:** `sdk-node/src/capture/captureError.ts:137-151`
2. **Type Definition:** `sdk-node/src/types/event.ts:64-85`
3. **Production Data:** `cornv2/errors/*.json`

All verified on 2026-08-02.

---

**End of Analysis**
