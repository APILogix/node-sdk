# SDK Field Generation Lifecycle

**Document Version:** 1.0.0  
**Last Updated:** August 1, 2026  
**SDK:** Pulse Node.js SDK

---

## Overview

This document explains **when and how** each field in SDK events is generated, where in the codebase it happens, and what triggers its creation.

---

## Table of Contents

1. [Correlation IDs](#correlation-ids)
2. [Session Management](#session-management)
3. [User & Tenant Identification](#user--tenant-identification)
4. [Request Context](#request-context)
5. [Trace & Span IDs](#trace--span-ids)
6. [Timestamps](#timestamps)
7. [Metadata](#metadata)
8. [Event-Specific Fields](#event-specific-fields)

---

## Correlation IDs

### eventId

**Type:** String (UUID v4)  
**Format:** `"550e8400-e29b-41d4-a716-446655440000"`

**When Generated:**
- **Time:** During event pipeline processing
- **File:** `src/core/event-pipeline.ts:112`
- **Trigger:** If not provided by caller

**Generation Code:**
```typescript
// src/core/event-pipeline.ts
const eventId = (rawEvent.eventId && typeof rawEvent.eventId === 'string')
    ? rawEvent.eventId
    : generateId()
```

**Generation Function:**
```typescript
// src/utils/uuid.ts
import { randomUUID } from 'crypto'

export function generateId(): string {
    return randomUUID()  // Node.js crypto.randomUUID()
}
```

**Lifecycle:**
```
Event Capture → Check if eventId exists → If missing, generate UUID v4 → Attach to event
```

**Used For:**
- Event deduplication
- Backend correlation
- Receipt tracking

---

### requestId

**Type:** String (UUID v4 or custom)  
**Format:** `"req_7f8d9e0a1b2c"` or UUID v4

**When Generated:**
- **Time:** At HTTP request ingress (middleware entry)
- **File:** `src/instrumentation/express.ts:84`
- **Trigger:** Incoming HTTP request

**Generation Code:**
```typescript
// src/instrumentation/express.ts:84-87
const requestId = headerString(req.headers['x-request-id'])
  ?? headerString(req.headers['x-correlation-id'])
  ?? generateId()
```

**Priority Order:**
1. ✅ Use `X-Request-Id` header if present
2. ✅ Use `X-Correlation-Id` header if present
3. ✅ Generate new UUID v4 if neither exists

**Lifecycle:**
```
HTTP Request → Extract from headers → If missing, generate → Store in ContextStore
```

**Propagation:**
- Stored in AsyncLocalStorage ContextStore
- Attached to all events in request scope
- Survives across async boundaries

**Also Used In:**
- Fastify: `src/instrumentation/fastify.ts:143`
- Manual context creation: `src/core/context.ts:175`

---

## Session Management

### sessionId

**Type:** String (UUID v4)  
**Format:** `"session_xyz_12345"` or UUID v4

**When Generated:**
- **Time:** On first session access OR from HTTP header
- **File:** `src/session/session-manager.ts:76`
- **Trigger:** `getSession()` called when no active session

**Generation Code:**
```typescript
// src/session/session-manager.ts:76-86
getSession(): Session {
    const now = epochMs()

    if (this.currentSession && this.isExpired(this.currentSession, now)) {
        this.endSession('expired')
    }

    if (!this.currentSession) {
        this.currentSession = this.createSession(now)
        this.totalSessions += 1
    }

    return this.currentSession
}

// Session creation
private createSession(now: number): Session {
    return {
        id: generateId(),  // ← sessionId generated here
        startedAt: now,
        lastActivityAt: now,
        eventCount: 0,
        errorCount: 0,
        crashed: false,
        status: 'active'
    }
}
```

**Alternative Source - HTTP Header:**
```typescript
// src/instrumentation/express.ts:112
const sessionId = headerString(req.headers['x-session-id'])
```

**Priority Order:**
1. ✅ Use `X-Session-Id` header if present
2. ✅ Use existing active session if valid
3. ✅ Generate new session if expired or missing

**Session Expiry:**
```typescript
// Session expires when:
// 1. Idle timeout: 30 minutes of no activity (DEFAULT_IDLE_TIMEOUT_MS)
// 2. Max duration: 4 hours total (DEFAULT_MAX_DURATION_MS)
```

**Lifecycle:**
```
Request arrives → Check X-Session-Id header → If missing, check active session
              ↓
   Session expired or none exists? → Create new session with UUID v4 → Store in SessionManager
              ↓
   Event captured → SessionManager.getSessionId() → Attach to event
```

**Enrichment in Pipeline:**
```typescript
// src/core/event-pipeline.ts:703-706
const sessionMgr = peekSessionManager()
if (sessionMgr) {
    const sessionId = sessionMgr.getSessionId() ?? sessionMgr.getSession().id
    enrichment['sessionId'] = sessionId
}
```

**Key Points:**
- ✅ **One session per user session** (browser tab, app instance)
- ✅ **Survives page refreshes** if header provided
- ✅ **Expires after inactivity** (30 min default)
- ✅ **Auto-renewed** on any event activity
- ✅ **Tracked for crash-free rate** calculation

---

## User & Tenant Identification

### userId

**Type:** String or number (converted to string)  
**Format:** `"user_123"`, `"auth0|123456"`, `42`

**When Generated:**
- **Time:** At HTTP request (from request object)
- **File:** `src/instrumentation/express.ts:112` or `fastify.ts:146`
- **Trigger:** Request middleware extraction

**Extraction Code:**
```typescript
// src/instrumentation/express.ts:275-279
function readUserId(req: Request): string | undefined {
    const user = (req as Request & { user?: { id?: unknown; userId?: unknown } }).user
    const value = user?.id ?? user?.userId
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}
```

**Priority Order:**
1. ✅ `req.user.id` (Passport.js, Auth0 pattern)
2. ✅ `req.user.userId` (Custom auth pattern)
3. ⚠️ If neither exists → `undefined`

**Source Dependencies:**
- **Express/Fastify:** Requires authentication middleware to populate `req.user`
- **Passport.js:** Automatically sets `req.user.id`
- **Auth0:** Sets `req.user.sub` or `req.user.user_id`
- **Custom Auth:** Must set `req.user` object

**Lifecycle:**
```
Auth Middleware runs → Populates req.user → SDK middleware extracts userId
                                          ↓
                            Store in ContextStore → Attach to all events
```

**Also Used In:**
- Fastify: `src/instrumentation/fastify.ts:146`
- Manual: Can be set via `setUser()` API (if available)

---

### tenantId

**Type:** String  
**Format:** `"tenant_abc"`, `"org_12345"`

**When Generated:**
- **Time:** At HTTP request (from header or context)
- **File:** `src/instrumentation/express.ts:93`
- **Trigger:** Incoming request with `X-Tenant-Id` header

**Extraction Code:**
```typescript
// src/instrumentation/express.ts:93
const tenantId = headerString(req.headers['x-tenant-id'])
```

**Also Extracted From:**
```typescript
// From request context extra field
const tenantId = ctx?.extra?.['tenantId']
```

**Priority Order:**
1. ✅ `X-Tenant-Id` HTTP header
2. ✅ Context extra field
3. ⚠️ If neither exists → `undefined`

**Lifecycle:**
```
Request with X-Tenant-Id → Extract header → Store in context.extra.tenantId
                                          ↓
                            Attach to spans and events → Backend sees tenantId
```

**Multi-Tenancy Support:**
- ✅ **Per-request isolation:** Each request has its own tenantId
- ✅ **Cost governance:** TenantGovernor tracks per-tenant limits
- ✅ **Sampling:** Can apply tenant-specific sampling rules

---

## Request Context

### clientIp

**Type:** String  
**Format:** `"192.168.1.100"`, `"2001:0db8:85a3::8a2e:0370:7334"`

**When Generated:**
- **Time:** At HTTP request
- **File:** `src/instrumentation/request-capture-utils.ts:150`
- **Trigger:** Request middleware

**Extraction Logic:**
```typescript
// src/instrumentation/request-capture-utils.ts
export function resolveClientIp(
    headers: Record<string, unknown>,
    socketAddress: string | undefined,
    trustedProxies?: readonly string[],
    maskIp?: boolean
): string | undefined {
    if (maskIp) return undefined

    // If behind trusted proxy, use X-Forwarded-For
    if (trustedProxies && isTrustedProxy(socketAddress, trustedProxies)) {
        const forwarded = headerString(headers['x-forwarded-for'])
        if (forwarded) {
            return forwarded.split(',')[0]?.trim()
        }
        const realIp = headerString(headers['x-real-ip'])
        if (realIp) return realIp
    }

    // Otherwise use socket address
    return socketAddress
}
```

**Priority Order (when behind proxy):**
1. ✅ `X-Forwarded-For` header (first IP)
2. ✅ `X-Real-IP` header
3. ✅ Socket remote address

**Priority Order (direct connection):**
1. ✅ Socket remote address only

**Security:**
- ⚠️ **Trusted proxy validation:** Only reads headers if proxy is trusted
- ✅ **Masking:** Can be disabled via config `maskIp: true`
- ✅ **IPv6 support:** Handles both IPv4 and IPv6

---

### userAgent

**Type:** String  
**Format:** `"Mozilla/5.0 (Windows NT 10.0; Win64; x64)..."`

**When Generated:**
- **Time:** At HTTP request
- **File:** `src/instrumentation/express.ts:114`
- **Trigger:** Extract from `User-Agent` header

**Extraction Code:**
```typescript
// src/instrumentation/express.ts:114
const userAgent = headerString(req.headers['user-agent'])
```

**Used For:**
- Browser/device identification
- Bot detection
- Analytics

---

### referer

**Type:** String  
**Format:** `"https://example.com/dashboard"`

**When Generated:**
- **Time:** At HTTP request
- **File:** `src/instrumentation/express.ts:115`
- **Trigger:** Extract from headers

**Extraction Code:**
```typescript
// src/instrumentation/express.ts:115
const referer = headerString(req.headers['referer'] ?? req.headers['referrer'])
```

**Note:** Handles both `referer` (misspelled HTTP standard) and `referrer` spelling.

---

## Trace & Span IDs

### traceId

**Type:** String (hexadecimal)  
**Length:** 32 characters  
**Format:** `"4bf92f3577b34da6a3ce929d0e0e4736"`

**When Generated:**
- **Time:** When span is created by OpenTelemetry
- **Generator:** OpenTelemetry SDK (W3C Trace Context)
- **File:** Not generated by Pulse SDK - delegated to OTel

**Extraction for Events:**
```typescript
// src/core/context.ts:72-74
export function getTraceId(): string | undefined {
    return trace.getActiveSpan()?.spanContext().traceId 
        ?? getRequestContext()?.traceId
}
```

**Priority Order:**
1. ✅ Active span's traceId (from AsyncLocalStorage)
2. ✅ Request context's traceId (captured at span creation)
3. ⚠️ `undefined` if no active trace

**Propagation:**
```
Incoming HTTP Request with traceparent header
         ↓
OTel extracts traceId → Continues existing trace
         ↓
OR creates new traceId → Starts new trace
         ↓
Stored in span context → Available via getTraceId()
```

**Lifecycle:**
```
Root span created → traceId generated (128-bit random)
                 ↓
Child spans inherit same traceId → All spans in trace share traceId
                 ↓
Events use getTraceId() → Correlated to trace
```

---

### spanId

**Type:** String (hexadecimal)  
**Length:** 16 characters  
**Format:** `"00f067aa0ba902b7"`

**When Generated:**
- **Time:** When each span is created
- **Generator:** OpenTelemetry SDK
- **File:** Not generated by Pulse SDK

**Extraction for Events:**
```typescript
// src/core/context.ts:77-79
export function getSpanId(): string | undefined {
    return trace.getActiveSpan()?.spanContext().spanId 
        ?? getRequestContext()?.spanId
}
```

**Uniqueness:**
- ✅ **Each span gets unique spanId**
- ✅ **64-bit random** (collision probability ~0)
- ✅ **Different for every operation**

---

### parentSpanId

**Type:** String (hexadecimal) or null  
**Length:** 16 characters  
**Format:** `"b1f067aa0ba902b8"` or `null`

**When Generated:**
- **Time:** When child span is created
- **File:** `src/tracing/tracer.ts:246`
- **Source:** Parent span's spanId

**Extraction Code:**
```typescript
// src/tracing/tracer.ts:246
const parentSpanId = span.parentSpanContext?.spanId
```

**Rules:**
- ✅ **Root spans:** `parentSpanId = null` or omitted
- ✅ **Child spans:** `parentSpanId = parent.spanId`
- ✅ **Nested spans:** Each child references immediate parent

**Lifecycle:**
```
Root span created → parentSpanId = null
         ↓
Child span created → parentSpanId = root.spanId
         ↓
Grandchild created → parentSpanId = child.spanId
```

---

## Timestamps

### timestamp

**Type:** Number (epoch milliseconds)  
**Format:** `1722528000000`

**When Generated:**
- **Time:** At event creation
- **File:** Varies by event type
- **Function:** `epochMs()`

**Generation Code:**
```typescript
// src/utils/time.ts
export function epochMs(): number {
    return Date.now()
}
```

**Usage:**
```typescript
// Error event: src/capture/captureError.ts:138
const event: ErrorEvent = {
    timestamp: epochMs(),
    // ...
}

// Request event: src/instrumentation/express.ts:116
const startTime = Date.now()
// ... later ...
timestamp: startTime
```

**Precision:** Millisecond-level (JavaScript Date.now())

---

## Metadata

### metadata (Complete Object)

**Type:** Object  
**When Generated:** During event pipeline enrichment  
**File:** `src/core/event-pipeline.ts:740-755`

**Generation Code:**
```typescript
// src/core/event-pipeline.ts:740-755
function buildMetadata(config: RemoteConfigResponse): EventMetadata {
    return {
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
        applicationName: config.sdk.service ?? config.sdk.projectId,
        applicationVersion: config.sdk.release,
        projectId: config.sdk.projectId,
        environment: config.sdk.environment,
        release: config.sdk.release,
        serverName: os.hostname(),
    }
}
```

**Fields:**

| Field | Source | When Set | Example |
|-------|--------|----------|---------|
| `sdkName` | Constant | SDK import | `"@pulse/sdk-node"` |
| `sdkVersion` | Constant | SDK import | `"1.0.0"` |
| `applicationName` | Config | SDK init | `"my-app"` |
| `applicationVersion` | Config/package.json | SDK init | `"2.3.1"` |
| `projectId` | Config | SDK init | `"proj_abc123"` |
| `environment` | Config | SDK init | `"production"` |
| `release` | Config | SDK init | `"v2.3.1"` |
| `serverName` | OS | Event pipeline | `"web-server-01"` |

**Immutability:**
- ✅ **Cannot be overridden** by user code
- ✅ **Set once** during pipeline processing
- ✅ **Same for all events** in application instance

---

## Event-Specific Fields

### Error Event Fields

#### stack

**Type:** Array of StackFrame objects  
**When Generated:** During error capture  
**File:** `src/capture/captureError.ts:126`

**Generation:**
```typescript
// src/capture/captureError.ts:126
const stackFrames = parseStack(normalized.stack, normalized)
```

**Parser:** `src/processors/stack-parser.ts`

**Timing:** Immediately when error is captured

---

#### fingerprint

**Type:** String  
**When Generated:** During error capture  
**File:** `src/capture/captureError.ts:144`

**Generation:**
```typescript
// src/capture/captureError.ts:144
const fingerprint = generateFingerprint(normalized, normalizedFrames, customFingerprint)
```

**Algorithm:** Combines error name + function + file + line number

**Example:** `"TypeError:getUserName:user.js:42"`

---

#### breadcrumbs

**Type:** Array of Breadcrumb objects  
**When Generated:** Retrieved from ContextStore  
**File:** `src/capture/captureError.ts:147-150`

**Generation:**
```typescript
const ctx = getRequestContext()
const rawBreadcrumbs = ctx?.breadcrumbs.toArray() ?? []
```

**Accumulation:**
- ✅ Added via `addBreadcrumb()` throughout request
- ✅ Stored in RingBuffer (max 100 by default)
- ✅ Attached to errors when captured

---

### Span Event Fields

#### startTime / endTime

**Type:** Number (epoch milliseconds)  
**When Generated:** By OpenTelemetry during span lifecycle  
**File:** `src/tracing/tracer.ts:298-299`

**Extraction:**
```typescript
const startTimeMs = hrTimeToMs(span.startTime)
const endTimeMs = hrTimeToMs(span.endTime)
```

**Conversion:** OpenTelemetry uses high-resolution time, converted to milliseconds

---

#### duration

**Type:** Number (milliseconds)  
**When Generated:** Calculated during span export  
**File:** `src/tracing/tracer.ts:245`

**Calculation:**
```typescript
const durationMs = hrTimeToMs(span.duration)
```

**Formula:** `endTime - startTime`

---

#### exclusiveDuration

**Type:** Number (milliseconds)  
**When Generated:** Calculated during span export  
**File:** `src/tracing/tracer.ts:302-303`

**Calculation:**
```typescript
const childIntervals = spanDurationTracker.getChildIntervals(ctx.traceId, ctx.spanId)
const durationBreakdown = computeExclusiveDuration(startTimeMs, endTimeMs, childIntervals)
```

**Formula:** `total duration - time spent in child spans`

**Purpose:** Shows time spent in span's own code (not waiting for children)

---

## Summary Table

| Field | Generated When | Source | File Location |
|-------|----------------|--------|---------------|
| `eventId` | Event pipeline | UUID v4 | `event-pipeline.ts:112` |
| `requestId` | HTTP request | Header or UUID | `express.ts:84` |
| `sessionId` | Session access | Header or UUID | `session-manager.ts:76` |
| `userId` | HTTP request | `req.user.id` | `express.ts:112` |
| `tenantId` | HTTP request | `X-Tenant-Id` header | `express.ts:93` |
| `traceId` | Span creation | OpenTelemetry | OTel SDK |
| `spanId` | Span creation | OpenTelemetry | OTel SDK |
| `parentSpanId` | Child span | Parent's spanId | `tracer.ts:246` |
| `timestamp` | Event creation | Date.now() | Various |
| `metadata` | Pipeline | Config + constants | `event-pipeline.ts:740` |

---

## Common Patterns

### Pattern 1: Request Correlation
```
HTTP Request arrives
    ↓
Generate/extract requestId → Store in ContextStore
    ↓
All events in request scope → Include requestId
```

### Pattern 2: Trace Correlation
```
Span created → traceId + spanId generated by OTel
    ↓
Event captured → getTraceId() + getSpanId()
    ↓
Event includes trace/span IDs → Backend correlates
```

### Pattern 3: Session Tracking
```
First event in session → SessionManager creates session
    ↓
Session ID generated (UUID v4) → Stored in SessionManager
    ↓
All subsequent events → Include sessionId from SessionManager
    ↓
Idle 30 min → Session expires → New session created
```

---

## Configuration Impact

### Fields Affected by Config

| Field | Config Key | Impact |
|-------|-----------|--------|
| `clientIp` | `privacy.maskIp` | If true, clientIp omitted |
| `headers` | `privacy.capture.headers` | If false, headers omitted |
| `body` | `privacy.capture.body` | If false, body omitted |
| `query` | `privacy.capture.query` | If false, query omitted |
| `sessionId` | Session subsystem | Only if SessionManager started |
| `breadcrumbs` | `maxBreadcrumbs` | Limits breadcrumb count |

---

**End of Document**
