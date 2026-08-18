# Field Generation Quick Reference

Visual guide to when each field is generated in the SDK.

---

## HTTP Request Flow

```
┌─────────────────────────────────────────────────────────────┐
│  HTTP Request Arrives                                        │
│  GET /api/users/123                                          │
│  Headers:                                                    │
│    X-Request-Id: req_abc123         ← Used if present       │
│    X-Session-Id: session_xyz        ← Used if present       │
│    X-Tenant-Id: tenant_123          ← Used if present       │
│    User-Agent: Mozilla/5.0          ← Extracted             │
│    Referer: https://example.com     ← Extracted             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Express/Fastify Middleware                                  │
│  File: src/instrumentation/express.ts                        │
├─────────────────────────────────────────────────────────────┤
│  GENERATED/EXTRACTED:                                        │
│  ✓ requestId      → From header OR UUID v4                  │
│  ✓ sessionId      → From header OR SessionManager           │
│  ✓ tenantId       → From X-Tenant-Id header                 │
│  ✓ userId         → From req.user.id (auth middleware)      │
│  ✓ clientIp       → From X-Forwarded-For or socket          │
│  ✓ userAgent      → From User-Agent header                  │
│  ✓ referer        → From Referer header                     │
│                                                              │
│  CREATED:                                                    │
│  ✓ ContextStore   → Stored in AsyncLocalStorage             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  OpenTelemetry Span Creation                                 │
│  Generator: OTel HttpInstrumentation                         │
├─────────────────────────────────────────────────────────────┤
│  GENERATED:                                                  │
│  ✓ traceId        → 32-char hex (W3C format)                │
│  ✓ spanId         → 16-char hex                             │
│  ✓ parentSpanId   → From traceparent header OR null         │
│  ✓ startTime      → High-resolution timestamp               │
│                                                              │
│  ACTIVATED:                                                  │
│  ✓ Span becomes active in AsyncLocalStorage                 │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Application Code Runs                                       │
│  (Database calls, API calls, business logic)                 │
├─────────────────────────────────────────────────────────────┤
│  Child spans created automatically:                          │
│  • Prisma query   → parentSpanId = root spanId              │
│  • Redis get      → parentSpanId = root spanId              │
│  • HTTP fetch     → parentSpanId = root spanId              │
│                                                              │
│  Events captured:                                            │
│  • Error          → Gets traceId, spanId from context       │
│  • Log            → Gets traceId, spanId from context       │
│  • Message        → Gets traceId, spanId from context       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Event Pipeline Processing                                   │
│  File: src/core/event-pipeline.ts                           │
├─────────────────────────────────────────────────────────────┤
│  GENERATED:                                                  │
│  ✓ eventId        → UUID v4 (if not provided)               │
│  ✓ timestamp      → Date.now() (if not provided)            │
│  ✓ metadata       → Built from config + constants           │
│                                                              │
│  ENRICHED:                                                   │
│  ✓ sessionId      → From SessionManager                     │
│  ✓ traceId        → From active span                        │
│  ✓ spanId         → From active span                        │
│  ✓ requestId      → From ContextStore                       │
│  ✓ userId         → From ContextStore                       │
│  ✓ tenantId       → From ContextStore                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  Transport to Backend                                        │
│  Complete event with all fields                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Session Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│  Trigger: First Event OR Session Check                       │
└──────────────────────────────────────────────────────────────┘
                          ↓
         ┌────────────────────────────┐
         │  Check for X-Session-Id    │
         │  header                    │
         └────────────────────────────┘
                 ↓              ↓
          YES  exists     NO doesn't exist
                 ↓              ↓
         ┌───────────────┐  ┌──────────────────────────┐
         │ Use header    │  │ Check SessionManager     │
         │ value         │  │ for active session       │
         └───────────────┘  └──────────────────────────┘
                 ↓              ↓              ↓
                 │         Has active    No active
                 │         session       session
                 │              ↓              ↓
                 │      ┌────────────┐  ┌─────────────────┐
                 │      │ Check if   │  │ Generate new    │
                 │      │ expired    │  │ UUID v4         │
                 │      └────────────┘  │ sessionId       │
                 │        ↓        ↓    └─────────────────┘
                 │     Expired  Valid          ↓
                 │        ↓        │            │
                 │   ┌─────────┐  │            │
                 │   │ Create  │  │            │
                 │   │ new     │  │            │
                 │   └─────────┘  │            │
                 │        ↓        ↓            ↓
                 └────────┴────────┴────────────┘
                          ↓
          ┌───────────────────────────────────┐
          │  sessionId stored in              │
          │  SessionManager                   │
          │                                   │
          │  Attached to all events in scope  │
          └───────────────────────────────────┘
                          ↓
          ┌───────────────────────────────────┐
          │  Session Activity Tracking        │
          ├───────────────────────────────────┤
          │  • lastActivityAt updated         │
          │  • eventCount incremented         │
          │  • errorCount tracked             │
          │  • crashed flag if errors occur   │
          └───────────────────────────────────┘
                          ↓
          ┌───────────────────────────────────┐
          │  Session Expiry Check             │
          ├───────────────────────────────────┤
          │  Expires if:                      │
          │  • 30 min idle (no activity)      │
          │  • 4 hours max duration           │
          │                                   │
          │  Then: Create new session         │
          └───────────────────────────────────┘
```

---

## ID Generation Timeline

```
┌─────────────────────────────────────────────────────────────────┐
│  TIME: HTTP Request Arrival (T=0)                               │
├─────────────────────────────────────────────────────────────────┤
│  requestId     GENERATED    → UUID v4 or from header            │
│  sessionId     LOOKUP/GEN   → From header, manager, or new      │
│  userId        EXTRACTED    → From req.user.id                  │
│  tenantId      EXTRACTED    → From X-Tenant-Id                  │
│  clientIp      EXTRACTED    → From headers or socket            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  TIME: OTel Span Created (T=1ms)                                │
├─────────────────────────────────────────────────────────────────┤
│  traceId       GENERATED    → 32-char hex (OTel)                │
│  spanId        GENERATED    → 16-char hex (OTel)                │
│  parentSpanId  EXTRACTED    → From traceparent OR null          │
│  startTime     RECORDED     → High-res timestamp                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  TIME: Child Span Created (T=50ms)                              │
├─────────────────────────────────────────────────────────────────┤
│  spanId        GENERATED    → New 16-char hex                   │
│  traceId       INHERITED    → Same as parent                    │
│  parentSpanId  SET          → Parent's spanId                   │
│  startTime     RECORDED     → High-res timestamp                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  TIME: Error Captured (T=100ms)                                 │
├─────────────────────────────────────────────────────────────────┤
│  timestamp     GENERATED    → Date.now()                        │
│  traceId       EXTRACTED    → From active span                  │
│  spanId        EXTRACTED    → From active span                  │
│  fingerprint   GENERATED    → From error + stack                │
│  breadcrumbs   COLLECTED    → From ContextStore                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  TIME: Event Pipeline (T=101ms, async)                          │
├─────────────────────────────────────────────────────────────────┤
│  eventId       GENERATED    → UUID v4 if missing                │
│  metadata      BUILT        → From config                       │
│  sessionId     ENRICHED     → From SessionManager               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  TIME: Span Ended (T=245ms)                                     │
├─────────────────────────────────────────────────────────────────┤
│  endTime       RECORDED     → High-res timestamp                │
│  duration      CALCULATED   → endTime - startTime               │
│  exclusiveDuration CALC     → duration - child durations        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Field Sources

### From HTTP Headers
```
X-Request-Id       → requestId
X-Session-Id       → sessionId
X-Tenant-Id        → tenantId
User-Agent         → userAgent
Referer/Referrer   → referer
X-Forwarded-For    → clientIp (if trusted proxy)
traceparent        → traceId, spanId, parentSpanId (OTel)
```

### From Authentication Middleware
```
req.user.id        → userId
req.user.userId    → userId (fallback)
```

### From OpenTelemetry
```
traceId            → W3C Trace Context (32-char hex)
spanId             → OTel ID Generator (16-char hex)
parentSpanId       → Parent span's spanId
startTime/endTime  → High-resolution timestamps
```

### From SDK Generators
```
eventId            → crypto.randomUUID() (UUID v4)
requestId          → crypto.randomUUID() (if no header)
sessionId          → crypto.randomUUID() (if new session)
fingerprint        → Error analysis algorithm
```

### From Configuration
```
metadata.sdkName          → SDK constant
metadata.sdkVersion       → SDK constant
metadata.applicationName  → config.sdk.service
metadata.projectId        → config.sdk.projectId
metadata.environment      → config.sdk.environment
```

### From Runtime
```
timestamp          → Date.now()
serverName         → os.hostname()
```

---

## Key Takeaways

✅ **requestId** - Generated at request ingress (middleware)  
✅ **sessionId** - Generated on first session access or from header  
✅ **userId** - Extracted from auth middleware (`req.user`)  
✅ **tenantId** - Extracted from `X-Tenant-Id` header  
✅ **traceId** - Generated by OpenTelemetry (W3C standard)  
✅ **spanId** - Generated by OpenTelemetry (per span)  
✅ **parentSpanId** - Set to parent's spanId (null for root)  
✅ **eventId** - Generated in event pipeline (UUID v4)  
✅ **timestamp** - Captured at event creation (Date.now())  
✅ **metadata** - Built from config during pipeline processing  

---

**For detailed lifecycle information, see:** `FIELD_GENERATION_LIFECYCLE.md`
