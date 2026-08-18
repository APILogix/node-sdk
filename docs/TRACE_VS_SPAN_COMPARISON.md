# Trace Events vs Span Events: Field Comparison

Quick reference showing what's sent in individual span events vs aggregated trace events.

---

## Side-by-Side Comparison

### Individual Span Events (Type: "span")

Sent **individually** for each span as it completes.

```json
{
  "type": "span",
  "eventId": "span_00f067aa0ba902b7",
  "spanId": "00f067aa0ba902b7",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "parentSpanId": "b1f067aa0ba902b8",  // ← YES, included!
  "name": "GET /api/users/:id",
  "kind": "server",
  "startTime": 1722528000000,
  "endTime": 1722528000245,
  "duration": 245,
  "status": "ok",
  "attributes": { /* ... */ },
  "events": [ /* ... */ ],
  "links": [ /* ... */ ]
}
```

**Key Points:**
- ✅ Flat structure
- ✅ `parentSpanId` at top level
- ✅ No `children` array
- ✅ One event per span

---

### Aggregated Trace Event (Type: "trace")

Sent **once** when root span completes (all children finished).

```json
{
  "type": "trace",
  "eventId": "trace_4bf92f3577b34da6a3ce929d0e0e4736",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanCount": 3,
  "totalDuration": 845,
  "isPartial": false,
  "rootSpan": {
    "spanId": "00f067aa0ba902b7",
    "parentSpanId": null,                    // ← Root has no parent
    "name": "GET /api/users/:id",
    "kind": "server",
    "startTime": 1722528000000,
    "endTime": 1722528000845,
    "duration": 845,
    "status": "ok",
    "children": [                            // ← Nested hierarchy
      {
        "spanId": "11g178bb1cb013c8",
        "parentSpanId": "00f067aa0ba902b7",  // ← Child has parent!
        "name": "db.query",
        "duration": 600,
        "children": [
          {
            "spanId": "22h289cc2dc124d9",
            "parentSpanId": "11g178bb1cb013c8",  // ← Grandchild too!
            "name": "redis.get",
            "duration": 50,
            "children": []
          }
        ]
      }
    ]
  }
}
```

**Key Points:**
- ✅ Hierarchical structure with `children` arrays
- ✅ `parentSpanId` in EVERY span (root, children, grandchildren)
- ✅ One event for entire trace
- ✅ Pre-built tree structure

---

## What Gets Sent to Backend

### Scenario: 3-Span Trace

```
Request comes in
  ├─ Root span (HTTP)
  ├─ Child span (DB query)
  └─ Grandchild span (Redis)
```

### Phase 1: Individual Span Events (3 events)

```json
// Event 1: Root span ends
{
  "type": "span",
  "spanId": "root123",
  "traceId": "trace456",
  "parentSpanId": null
}

// Event 2: Child span ends
{
  "type": "span",
  "spanId": "child789",
  "traceId": "trace456",
  "parentSpanId": "root123"  // ← References parent
}

// Event 3: Grandchild span ends
{
  "type": "span",
  "spanId": "grand999",
  "traceId": "trace456",
  "parentSpanId": "child789"  // ← References parent
}
```

### Phase 2: Aggregated Trace Event (1 event)

```json
{
  "type": "trace",
  "traceId": "trace456",
  "spanCount": 3,
  "rootSpan": {
    "spanId": "root123",
    "parentSpanId": null,  // ← Still included
    "children": [
      {
        "spanId": "child789",
        "parentSpanId": "root123",  // ← Still included
        "children": [
          {
            "spanId": "grand999",
            "parentSpanId": "child789"  // ← Still included
          }
        ]
      }
    ]
  }
}
```

**Total Events Sent:** 4 (3 individual spans + 1 aggregated trace)

---

## Field Presence Matrix

| Field | Span Event | Trace Event (Root) | Trace Event (Children) |
|-------|------------|-------------------|----------------------|
| `type` | `"span"` | `"trace"` | N/A (nested) |
| `eventId` | ✅ UUID v4 | ✅ `trace_{traceId}` | ❌ Not present |
| `traceId` | ✅ Yes | ✅ Yes (top-level) | ❌ Inherited |
| `spanId` | ✅ Yes | ✅ Yes (in rootSpan) | ✅ Yes (in each child) |
| `parentSpanId` | ✅ Yes (or null) | ✅ Yes (in rootSpan, null) | ✅ Yes (in each child) |
| `name` | ✅ Yes | ✅ Yes (in rootSpan) | ✅ Yes (in each child) |
| `children` | ❌ Not present | ✅ Yes (array) | ✅ Yes (nested arrays) |
| `spanCount` | ❌ Not present | ✅ Yes (trace-level) | ❌ Not present |
| `totalDuration` | ❌ Not present | ✅ Yes (trace-level) | ❌ Not present |
| `isPartial` | ❌ Not present | ✅ Yes (trace-level) | ❌ Not present |
| `requestId` | ✅ Optional | ✅ Optional (trace-level) | ❌ Not present |
| `sessionId` | ✅ Optional | ✅ Optional (trace-level) | ❌ Not present |

---

## When Each Event Type is Sent

### Span Events
- **Timing:** As each span ends
- **Frequency:** One per span
- **Order:** Child spans end before parents
- **Route:** `/v1/traces`

### Trace Events
- **Timing:** When root span ends (trace complete)
- **Frequency:** One per trace
- **Order:** After all child span events
- **Route:** `/v1/traces`

---

## Why Both Are Sent

### Individual Span Events
✅ **Real-time visibility** - See spans as they complete  
✅ **Streaming analysis** - Backend can process incrementally  
✅ **Partial traces** - Useful if aggregation fails  
✅ **OpenTelemetry compliance** - Standard format  

### Aggregated Trace Events
✅ **Complete hierarchy** - Pre-built tree structure  
✅ **Performance** - Backend doesn't need to reconstruct  
✅ **Waterfall view** - Ready for trace visualization  
✅ **Validation** - SDK validates structure before sending  

---

## Backend Usage

### Span Events (Individual)
```
Backend receives → Store in database → Index by traceId
                                    ↓
                        Can reconstruct trace from parentSpanId links
```

### Trace Events (Aggregated)
```
Backend receives → Use pre-built tree → Display waterfall immediately
                                     ↓
                        Validate using parentSpanId references
```

---

## Key Takeaway

**Both event types include `parentSpanId`:**

1. ✅ **Span events** have `parentSpanId` at top level
2. ✅ **Trace events** have `parentSpanId` in every nested span
3. ✅ Root spans have `parentSpanId: null` in both
4. ✅ Child spans reference parent's spanId in both

**This redundancy is intentional:**
- Enables backend validation
- Supports different storage models
- Provides fallback if tree is corrupted
- Complies with observability standards
