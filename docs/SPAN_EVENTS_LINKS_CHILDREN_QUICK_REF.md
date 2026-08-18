# Span Events, Links, and Children - Quick Reference

**Quick lookup guide for understanding the three array fields in SDK traces**

---

## Visual Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         SPAN                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                       │   │
│  │  events: [                                           │   │
│  │    { name: "cache.hit", timestamp: 123, ... }       │   │
│  │    { name: "exception", timestamp: 456, ... }       │   │
│  │  ]                                                   │   │
│  │                                                       │   │
│  │  ⭐ Time-stamped annotations WITHIN this span       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                       │   │
│  │  links: [                                            │   │
│  │    { traceId: "abc...", spanId: "def..." }          │   │
│  │    { traceId: "xyz...", spanId: "uvw..." }          │   │
│  │  ]                                                   │   │
│  │                                                       │   │
│  │  🔗 References to spans in OTHER traces             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                       │   │
│  │  children: [                                         │   │
│  │    { spanId: "child1", children: [...] },           │   │
│  │    { spanId: "child2", children: [...] }            │   │
│  │  ]                                                   │   │
│  │                                                       │   │
│  │  🌳 Child spans in THIS trace (only in TraceEvent)  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---


## Three-Second Summary

| Field | What | Scope |
|-------|------|-------|
| **`events`** | Markers in time | Within ONE span |
| **`links`** | References to other spans | Across DIFFERENT traces |
| **`children`** | Child span tree | Within SAME trace |

---

## Events: Timeline Markers

### Structure

```json
{
  "name": "string",
  "timestamp": 1234567890,
  "attributes": { /* optional */ }
}
```

### Examples

```json
[
  { "name": "cache.hit", "timestamp": 1785611401500 },
  { "name": "pulse.profile.start", "timestamp": 1785611401871 },
  { "name": "exception", "timestamp": 1785611403861, 
    "attributes": { "exception.type": "Error" } }
]
```

### When to Use

- ✅ Mark progress checkpoints
- ✅ Record cache hits/misses
- ✅ Log exceptions
- ✅ Track profiling start/end
- ❌ Reference other spans (use links)
- ❌ Show operation hierarchy (use children)

---

## Links: Cross-Trace References

### Structure

```json
{
  "traceId": "string",
  "spanId": "string",
  "attributes": { /* optional */ }
}
```


### Examples

```json
[
  {
    "traceId": "order_trace_1",
    "spanId": "order_span_1",
    "attributes": { "order.id": "12345" }
  },
  {
    "traceId": "order_trace_2",
    "spanId": "order_span_2",
    "attributes": { "order.id": "67890" }
  }
]
```

### When to Use

- ✅ Batch processing multiple messages
- ✅ Queue consumer linking to producer
- ✅ Fan-out operations
- ✅ Distributed sagas
- ❌ Parent-child in same trace (use parentSpanId)
- ❌ Timeline markers (use events)

---

## Children: Trace Hierarchy

### Structure

```json
{
  "spanId": "string",
  "parentSpanId": "string",
  "name": "string",
  "duration": 1234,
  "events": [...],
  "links": [...],
  "children": [
    { /* recursive AggregatedSpan */ }
  ]
}
```

### Example

```json
{
  "spanId": "root",
  "name": "GET /api/users",
  "children": [
    {
      "spanId": "db-query",
      "parentSpanId": "root",
      "name": "SELECT users",
      "children": []
    },
    {
      "spanId": "transform",
      "parentSpanId": "root",
      "name": "Transform data",
      "children": []
    }
  ]
}
```


### When to Use

- ✅ Visualize waterfall diagrams
- ✅ Show operation hierarchy
- ✅ Analyze performance attribution
- ✅ Automatic (built by TraceAggregator)
- ❌ Not available in individual SpanEvents
- ❌ Only in TraceEvent (type: 'trace')

---

## Location in Payloads

### Individual Span Event (type: 'span')

```json
{
  "type": "span",
  "spanId": "abc123",
  "traceId": "xyz789",
  "events": [ /* ✅ YES */ ],
  "links": [ /* ✅ YES */ ]
  // ❌ NO children field
}
```

### Aggregated Trace Event (type: 'trace')

```json
{
  "type": "trace",
  "traceId": "xyz789",
  "rootSpan": {
    "spanId": "abc123",
    "events": [ /* ✅ YES */ ],
    "links": [ /* ✅ YES */ ],
    "children": [ /* ✅ YES */ ]
  }
}
```

---

## Decision Tree

```
Need to record something?
│
├─ Is it a moment in time within this span?
│  └─ Use events (e.g., "cache.hit", "exception")
│
├─ Is it a reference to another trace?
│  └─ Use links (e.g., batch job → order spans)
│
└─ Is it showing the operation hierarchy?
   └─ Use children (automatic in TraceEvent)
```


---

## Code Examples

### Adding Events

```javascript
span.addEvent('cache.hit', { key: 'user:123' })
span.addEvent('query.executed', { rowCount: 1500 })
```

### Adding Links

```javascript
// At span creation
await PulseSDK.tracer.withSpan('process-batch', {
  links: [
    { traceId: 'msg1_trace', spanId: 'msg1_span' }
  ]
}, async (span) => { /* ... */ })

// During execution
span.addLink({ traceId: 'related_trace', spanId: 'related_span' })
```

### Children (Automatic)

```javascript
// Parent span
await PulseSDK.tracer.withSpan('parent', async (parentSpan) => {
  
  // Child span 1 - automatically becomes a child
  await PulseSDK.tracer.withSpan('child-1', async (child1) => {
    // ...
  })
  
  // Child span 2 - automatically becomes a child
  await PulseSDK.tracer.withSpan('child-2', async (child2) => {
    // ...
  })
})

// Result in TraceEvent:
// rootSpan: {
//   spanId: "parent",
//   children: [
//     { spanId: "child-1", children: [] },
//     { spanId: "child-2", children: [] }
//   ]
// }
```

---

## Common Mistakes

### ❌ Using events to reference other spans

```javascript
// DON'T DO THIS
span.addEvent('related-to-span', {
  otherTraceId: 'abc',
  otherSpanId: 'def'
})
```

**✅ Use links instead:**

```javascript
span.addLink({
  traceId: 'abc',
  spanId: 'def'
})
```


### ❌ Expecting children in SpanEvent

```javascript
// DON'T DO THIS
const spanEvent = { type: 'span', ... }
console.log(spanEvent.children)  // undefined!
```

**✅ Children only exist in TraceEvent:**

```javascript
const traceEvent = { type: 'trace', rootSpan: { children: [...] } }
console.log(traceEvent.rootSpan.children)  // ✅
```

### ❌ Using links for same-trace relationships

```javascript
// DON'T DO THIS (if they're in the same trace)
span.addLink({
  traceId: span.traceId,  // Same trace!
  spanId: parentSpanId
})
```

**✅ Use parentSpanId instead:**

```javascript
// Automatic - just create child spans
await PulseSDK.tracer.withSpan('child', async (child) => {
  // child.parentSpanId is set automatically
})
```

---

## Memory Aid

**E**vents = **E**verything happening **inside** one span  
**L**inks = **L**inks to **other traces**  
**C**hildren = **C**omplete tree of **child spans**

---

**End of Quick Reference**
