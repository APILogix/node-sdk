# Span Events, Links, and Children Documentation

**Version:** 3.0  
**Last Updated:** 2026-08-02  
**Purpose:** Comprehensive guide to understanding the `events`, `links`, and `children` fields in SDK span and trace payloads

---

## Table of Contents

1. [Overview](#overview)
2. [Events Array - Span Annotations](#events-array---span-annotations)
3. [Links Array - Cross-Trace References](#links-array---cross-trace-references)
4. [Children Array - Trace Hierarchy](#children-array---trace-hierarchy)
5. [Complete Examples](#complete-examples)
6. [When Each Field is Populated](#when-each-field-is-populated)
7. [Use Cases](#use-cases)

---

## Overview

The SDK's trace system includes three distinct array fields that serve different purposes:

| Field | Type | Purpose | Location |
|-------|------|---------|----------|
| **`events`** | `SpanEventItem[]` | Time-stamped annotations within a single span | In both `SpanEvent` and `AggregatedSpan` |
| **`links`** | `SpanLink[]` | References to related spans in other traces | In both `SpanEvent` and `AggregatedSpan` |
| **`children`** | `AggregatedSpan[]` | Hierarchical tree of child spans | In `AggregatedSpan` only (trace events) |

**Critical Distinction:**
- **`events` array** = Annotations/markers WITHIN a span (not other spans)
- **`children` array** = Nested child SPANS within a trace hierarchy

**Important: ERROR events vs Error SPANS**
- **ERROR events** (type: 'error') have `severity` field, NOT `status`
- **SPAN events** (type: 'span') have `status` field ('ok', 'error', 'unset')
- When a span fails, it has `status: "error"` and may include an `exception` event
- ERROR events are completely separate from spans

---

## Events Array - Span Annotations

### What Are Span Events?


Span events are **time-stamped annotations** attached to a single span. They represent notable moments or state changes that occur **during** the span's execution. Think of them as markers on a timeline.

**They are NOT:**
- Other spans
- Child operations
- Separate traces

**They ARE:**
- Timestamps of significant moments
- Profiling start markers
- Exception recordings
- Custom checkpoints
- Progress indicators

### SpanEventItem Structure

```typescript
interface SpanEventItem {
  readonly name: string                                          // Event name (e.g., "pulse.profile.start")
  readonly timestamp: number                                     // Epoch milliseconds when event occurred
  readonly attributes?: Readonly<Record<string, unknown>>        // Optional metadata about the event
}
```

### Type Definition Location

**Source:** `sdk-node/src/types/event.ts:125-129`

```typescript
export interface SpanEventItem {
  readonly name: string
  readonly timestamp: number
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
}
```

### How Events Are Added


**User API (`PulseSpan`):**

```javascript
// Add an event to the active span
span.addEvent('cache.hit', {
  key: 'user:123',
  ttl: 3600
})
```

**Source:** `sdk-node/src/tracing/span.ts:175-187`

```typescript
addEvent(name: string, attributes?: Attributes): this {
    if (this._ended) return this
    try {
        if (attributes) {
            this._span.addEvent(name, attributes)
        } else {
            this._span.addEvent(name)
        }
    } catch (err) {
        getLogger().warn('Failed to add span event', { name, error: err })
    }
    return this
}
```

**Exported in Span Events:**

Events are extracted from the OTel span and included in the `SpanEvent` payload.

**Source:** `sdk-node/src/tracing/tracer.ts:330-333` (spanToEvent method)

```typescript
events: span.events.map(e => ({
    name: e.name,
    timestamp: hrTimeToMs(e.time),
    attributes: e.attributes,
})),
```


### Real-World Example from Production

**Trace with Profiling Event:**

```json
{
  "spanId": "d6fd9dd3d143a832",
  "name": "parent-operation",
  "startTime": 1785611401440,
  "endTime": 1785611403855.6255,
  "events": [
    {
      "name": "pulse.profile.start",
      "timestamp": 1785611401871.1394,
      "attributes": {
        "profile.type": "cpu",
        "profile.id": "cpu:c569bd6c1e6c389b55e410081b09c9b7"
      }
    }
  ]
}
```

**Error Span with Exception Event:**

Note: This is a SPAN event (type: 'span'), not an ERROR event (type: 'error'). Spans have `status`, errors have `severity`.

```json
{
  "type": "span",
  "spanId": "1fb8a9e1a0a31db1",
  "name": "failing-operation",
  "status": "error",
  "statusMessage": "Intentional span failure for testing",
  "events": [
    {
      "name": "exception",
      "timestamp": 1785611403861.599,
      "attributes": {
        "exception.type": "Error",
        "exception.message": "Intentional span failure for testing",
        "exception.stacktrace": "Error: Intentional span failure for testing\n    at C:\\Users\\..."
      }
    }
  ]
}
```


### Common Event Names in SDK

| Event Name | When It Appears | Attributes |
|------------|-----------------|------------|
| `pulse.profile.start` | CPU profiling begins | `profile.type`, `profile.id` |
| `exception` | Error recorded on span | `exception.type`, `exception.message`, `exception.stacktrace` |
| `pulse.span.timeout` | Span exceeds timeout | Timeout metadata |
| Custom user events | User calls `span.addEvent()` | User-defined |

---

## Links Array - Cross-Trace References

### What Are Span Links?

Span links represent **causal relationships between spans in different traces**. They model non-parent-child connections, such as:

- Batch job processing multiple messages
- Fan-out operations
- Queue consumer reading from multiple producers
- Microservices calling each other across trace boundaries

**They are NOT:**
- Parent-child relationships (use `parentSpanId` for that)
- Events within a span
- Same-trace references

**They ARE:**
- References to spans in OTHER traces
- Batch processing links
- Cross-service boundaries
- Queue message attribution


### SpanLink Structure

```typescript
interface SpanLink {
  readonly traceId: string        // Trace ID of the linked span
  readonly spanId: string         // Span ID of the linked span
  readonly attributes?: Readonly<Record<string, unknown>>  // Optional: relationship metadata
}
```

### Type Definition Location

**Source:** `sdk-node/src/types/event.ts:131-134`

```typescript
export interface SpanLink {
  readonly traceId: string
  readonly spanId: string
}
```

**Full Definition (user-facing):** `sdk-node/src/tracing/span.ts:48-56`

```typescript
export interface SpanLink {
  /** Trace ID of the linked span. */
  traceId: string
  /** Span ID of the linked span. */
  spanId: string
  /** Optional attributes describing the link relationship. */
  attributes?: Attributes
}
```

### How Links Are Added

**User API:**

```javascript
// Add a single link
span.addLink({
  traceId: 'abc123...',
  spanId: 'def456...',
  attributes: { reason: 'batch-job' }
})

// Add multiple links
span.addLinks([
  { traceId: 'trace1', spanId: 'span1' },
  { traceId: 'trace2', spanId: 'span2' }
])
```


**At Span Creation:**

```javascript
await PulseSDK.tracer.withSpan('process-batch', {
  links: [
    { traceId: messageTraceId1, spanId: messageSpanId1 },
    { traceId: messageTraceId2, spanId: messageSpanId2 }
  ]
}, async (span) => {
  // Process batch...
})
```

**Source:** `sdk-node/src/tracing/span.ts:189-200` (addLink)

```typescript
addLink(link: Link): this {
    if (this._ended) return this
    try {
        this._span.addLink(link)
    } catch (err) {
        getLogger().warn('Failed to add span link', { error: err })
    }
    return this
}
```

**Exported in Span Events:**

**Source:** `sdk-node/src/tracing/tracer.ts:334-337`

```typescript
links: span.links.map(l => ({
    traceId: l.context.traceId,
    spanId: l.context.spanId,
    attributes: l.attributes,
})),
```

### Real-World Example from Production

**Most spans have empty links arrays:**

```json
{
  "spanId": "d6fd9dd3d143a832",
  "name": "parent-operation",
  "links": []
}
```


**Example: Batch Processing with Links**

```json
{
  "spanId": "batch_processor_span",
  "name": "process-order-batch",
  "links": [
    {
      "traceId": "order_trace_1",
      "spanId": "order_span_1",
      "attributes": {
        "order.id": "12345",
        "link.type": "batch-item"
      }
    },
    {
      "traceId": "order_trace_2",
      "spanId": "order_span_2",
      "attributes": {
        "order.id": "67890",
        "link.type": "batch-item"
      }
    }
  ]
}
```

### Use Cases for Links

1. **Queue Consumers:** Link to the producer span that enqueued the message
2. **Batch Jobs:** Link to all individual items being processed
3. **Fan-Out Operations:** Link to all parallel operation traces
4. **Saga Patterns:** Link to previous steps in a distributed transaction
5. **Cross-Service Calls:** Link to upstream service spans (when not parent-child)

---

## Children Array - Trace Hierarchy

### What Are Children?

The `children` array contains the **complete hierarchical tree of child spans** within a trace. This field only exists in **aggregated trace events** (`type: 'trace'`), not in individual span events.


**Key Points:**
- Only exists in `TraceEvent` (aggregated traces)
- Does NOT exist in individual `SpanEvent` payloads
- Built by the `TraceAggregator` when the root span arrives
- Represents the full span tree for visualization (waterfall diagrams)

### AggregatedSpan Structure (with children)

```typescript
interface AggregatedSpan {
  readonly spanId: string
  readonly parentSpanId?: string                    // References the immediate parent
  readonly name: string
  readonly kind?: string
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly exclusiveDuration?: number
  readonly status: string
  readonly statusMessage?: string
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly events?: readonly SpanEventItem[]        // Span annotations
  readonly links?: readonly SpanLink[]              // Cross-trace references
  readonly children: AggregatedSpan[]               // ⭐ Recursive child spans
}
```

### Type Definition Location

**Source:** `sdk-node/src/types/event.ts:226-239` (AggregatedSpanEvent in event types)

```typescript
export interface AggregatedSpanEvent {
  readonly spanId: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  // ... other fields ...
  readonly children: readonly AggregatedSpanEvent[]
}
```


**Implementation Source:** `sdk-node/src/tracing/trace-aggregator.ts:61-75`

```typescript
export interface AggregatedSpan {
  readonly spanId: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  readonly kind?: string | undefined
  readonly startTime: number
  readonly endTime: number
  readonly duration: number
  readonly exclusiveDuration?: number | undefined
  readonly status: string
  readonly statusMessage?: string | undefined
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
  readonly events?: readonly { name: string; timestamp: number; attributes?: Readonly<Record<string, unknown>> }[] | undefined
  readonly links?: readonly { traceId: string; spanId: string; attributes?: Readonly<Record<string, unknown>> }[] | undefined
  readonly children: AggregatedSpan[]
}
```

### How Children Are Built

**TraceAggregator Process:**

1. Individual span events arrive at the exporter
2. `TraceAggregator.addSpan()` buffers them by `traceId`
3. When the **root span** (no `parentSpanId`) arrives, aggregation triggers
4. `buildTree()` recursively constructs the hierarchy using `parentSpanId` links
5. A single `TraceEvent` with embedded `rootSpan.children` is emitted

**Source:** `sdk-node/src/tracing/trace-aggregator.ts:290-313` (buildTree method)


```typescript
private buildTree(
  rootEvent: Record<string, unknown>,
  childrenByParent: ReadonlyMap<string, Record<string, unknown>[]>,
): AggregatedSpan {
  const rootSpanId = rootEvent.spanId as string

  // Find direct children of this span — O(1) lookup
  const children = (childrenByParent.get(rootSpanId) ?? [])
    .map(child => this.buildTree(child, childrenByParent))

  return {
    spanId: rootSpanId,
    parentSpanId: rootEvent.parentSpanId as string | undefined,
    name: rootEvent.name as string,
    // ... all span fields ...
    events: rootEvent.events as AggregatedSpan['events'],
    links: rootEvent.links as AggregatedSpan['links'],
    children,  // ⭐ Recursive child array
  }
}
```

### Real-World Example from Production

**Trace Event with Children Hierarchy:**

```json
{
  "type": "trace",
  "traceId": "c569bd6c1e6c389b55e410081b09c9b7",
  "rootSpan": {
    "spanId": "d6fd9dd3d143a832",
    "name": "parent-operation",
    "startTime": 1785611401440,
    "endTime": 1785611403855.6255,
    "duration": 2415.6255,
    "children": [
      {
        "spanId": "fdee8a6ebe8e3638",
        "parentSpanId": "d6fd9dd3d143a832",
        "name": "child-db-query",
        "duration": 642.1987,
        "children": []
      },
      {
        "spanId": "80adfa82854dc986",
        "parentSpanId": "d6fd9dd3d143a832",
        "name": "child-transform",
        "duration": 1764.1394,
        "children": []
      }
    ]
  }
}
```


### Children Hierarchy Rules

1. **Root span has no `parentSpanId`** (or `parentSpanId: undefined`)
2. **Child spans reference their immediate parent** via `parentSpanId`
3. **Recursive structure:** Each child can have its own `children` array
4. **Sorted by startTime:** Children are ordered chronologically
5. **All spans in a trace share the same `traceId`**

---

## Complete Examples

### Example 1: Span with Events (CPU Profiling)

**Individual Span Event:**

```json
{
  "type": "span",
  "eventId": "span_d6fd9dd3d143a832",
  "spanId": "d6fd9dd3d143a832",
  "traceId": "c569bd6c1e6c389b55e410081b09c9b7",
  "name": "parent-operation",
  "startTime": 1785611401440,
  "endTime": 1785611403855.6255,
  "duration": 2415.6255,
  "status": "ok",
  "events": [
    {
      "name": "pulse.profile.start",
      "timestamp": 1785611401871.1394,
      "attributes": {
        "profile.type": "cpu",
        "profile.id": "cpu:c569bd6c1e6c389b55e410081b09c9b7"
      }
    }
  ],
  "links": []
}
```


### Example 2: Span with Exception Event

**Error Span Event (type: 'span'):**

Note: This is a SPAN that ended with error status, not an ERROR event. Spans have `status` field, ERROR events have `severity` field.

```json
{
  "type": "span",
  "eventId": "span_1fb8a9e1a0a31db1",
  "spanId": "1fb8a9e1a0a31db1",
  "traceId": "65d9b8b9e51edc4001b672fb4adab79c",
  "name": "failing-operation",
  "startTime": 1785611402104,
  "endTime": 1785611403861.6106,
  "duration": 1757.6105,
  "status": "error",
  "statusMessage": "Intentional span failure for testing",
  "events": [
    {
      "name": "exception",
      "timestamp": 1785611403861.599,
      "attributes": {
        "exception.type": "Error",
        "exception.message": "Intentional span failure for testing",
        "exception.stacktrace": "Error: Intentional span failure for testing\n    at C:\\Users\\vikas\\..."
      }
    }
  ],
  "links": []
}
```

### Example 3: Complete Trace with Children Hierarchy

**Aggregated Trace Event:**

```json
{
  "type": "trace",
  "eventId": "trace_c569bd6c1e6c389b55e410081b09c9b7",
  "traceId": "c569bd6c1e6c389b55e410081b09c9b7",
  "spanCount": 3,
  "totalDuration": 2415.6255,
  "isPartial": false,
  "rootSpan": {
    "spanId": "d6fd9dd3d143a832",
    "name": "parent-operation",
    "kind": "internal",
    "startTime": 1785611401440,
    "endTime": 1785611403855.6255,
    "duration": 2415.6255,
    "exclusiveDuration": 9.486083984375,
    "status": "ok",
    "attributes": {
      "layer": "parent",
      "route": "/tracing/nested"
    },
    "events": [
      {
        "name": "pulse.profile.start",
        "timestamp": 1785611401871.1394,
        "attributes": {
          "profile.type": "cpu"
        }
      }
    ],
    "links": [],
    "children": [
      {
        "spanId": "fdee8a6ebe8e3638",
        "parentSpanId": "d6fd9dd3d143a832",
        "name": "child-db-query",
        "kind": "internal",
        "startTime": 1785611401440,
        "endTime": 1785611402082.1987,
        "duration": 642.1987,
        "status": "ok",
        "attributes": {
          "db": "sqlite",
          "query": "SELECT * FROM users"
        },
        "events": [],
        "links": [],
        "children": []
      },
      {
        "spanId": "80adfa82854dc986",
        "parentSpanId": "d6fd9dd3d143a832",
        "name": "child-transform",
        "kind": "internal",
        "startTime": 1785611402082,
        "endTime": 1785611403846.1394,
        "duration": 1764.1394,
        "status": "ok",
        "events": [],
        "links": [],
        "children": []
      }
    ]
  }
}
```


### Example 4: Batch Job with Links (Hypothetical)

```json
{
  "type": "span",
  "spanId": "batch_span_123",
  "traceId": "batch_trace_abc",
  "name": "process-message-batch",
  "duration": 5000,
  "events": [
    {
      "name": "batch.started",
      "timestamp": 1785611401000,
      "attributes": {
        "batch.size": 10
      }
    },
    {
      "name": "batch.completed",
      "timestamp": 1785611406000,
      "attributes": {
        "items.processed": 10,
        "items.failed": 0
      }
    }
  ],
  "links": [
    {
      "traceId": "msg_trace_1",
      "spanId": "msg_span_1",
      "attributes": {
        "message.id": "msg-001",
        "link.type": "batch-item"
      }
    },
    {
      "traceId": "msg_trace_2",
      "spanId": "msg_span_2",
      "attributes": {
        "message.id": "msg-002",
        "link.type": "batch-item"
      }
    }
  ]
}
```

---

## When Each Field is Populated


### Events Array

| When | How |
|------|-----|
| **During span execution** | User calls `span.addEvent(name, attributes)` |
| **Exception recording** | `span.recordError(error)` adds an `exception` event |
| **CPU profiling** | Profiler adds `pulse.profile.start` event |
| **Span timeout** | Timeout guard adds `pulse.span.timeout` event |
| **Exported in** | Both `SpanEvent` (type: 'span') and `AggregatedSpan` (in traces) |

**Default Value:** Empty array `[]` if no events added

### Links Array

| When | How |
|------|-----|
| **At span creation** | User passes `links` in `SpanOptions` to `withSpan()` |
| **During span execution** | User calls `span.addLink(link)` or `span.addLinks([...])` |
| **Common use cases** | Batch processing, queue consumers, fan-out operations |
| **Exported in** | Both `SpanEvent` (type: 'span') and `AggregatedSpan` (in traces) |

**Default Value:** Empty array `[]` if no links added

### Children Array

| When | How |
|------|-----|
| **ONLY in TraceEvent** | Built by `TraceAggregator.buildTree()` |
| **After root span arrives** | Aggregator reconstructs hierarchy from buffered spans |
| **Using** | `parentSpanId` links between spans |
| **Recursive structure** | Each child can have its own children |
| **NOT in SpanEvent** | Individual span events don't have `children` |

**Default Value:** Empty array `[]` if span has no children (leaf span)


---

## Use Cases

### Events: Time-Stamped Annotations

**1. Progress Tracking:**

```javascript
await PulseSDK.tracer.withSpan('video-processing', async (span) => {
  span.addEvent('transcoding.started')
  await transcode(video)
  
  span.addEvent('thumbnail.generation.started')
  await generateThumbnail(video)
  
  span.addEvent('upload.started')
  await uploadToStorage(video)
})
```

**2. Cache Hit/Miss Tracking:**

```javascript
const cachedValue = cache.get(key)
if (cachedValue) {
  span.addEvent('cache.hit', { key, ttl: 3600 })
} else {
  span.addEvent('cache.miss', { key })
}
```

**3. Query Execution Milestones:**

```javascript
span.addEvent('query.prepared')
span.addEvent('query.executed', { rowCount: 1500 })
span.addEvent('results.serialized')
```

### Links: Cross-Trace References

**1. Queue Consumer:**

```javascript
// Producer creates a span and enqueues message
const producerSpanId = span.spanId
const producerTraceId = span.traceId
await queue.enqueue({ producerTraceId, producerSpanId, data })

// Consumer links back to producer
await PulseSDK.tracer.withSpan('process-message', {
  links: [{
    traceId: message.producerTraceId,
    spanId: message.producerSpanId
  }]
}, async (span) => {
  await processMessage(message.data)
})
```


**2. Batch Processing:**

```javascript
// Collect all order trace/span IDs
const orderLinks = orders.map(order => ({
  traceId: order.traceId,
  spanId: order.spanId,
  attributes: { orderId: order.id }
}))

// Process batch with links to all orders
await PulseSDK.tracer.withSpan('batch-process-orders', {
  links: orderLinks
}, async (span) => {
  await processBatch(orders)
})
```

**3. Saga Pattern / Distributed Transaction:**

```javascript
// Step 3 links to steps 1 and 2
await PulseSDK.tracer.withSpan('saga-step-3', {
  links: [
    { traceId: step1TraceId, spanId: step1SpanId },
    { traceId: step2TraceId, spanId: step2SpanId }
  ]
}, async (span) => {
  await executeStep3()
})
```

### Children: Trace Visualization

**1. Waterfall Diagrams:**

The backend uses the `children` array to render waterfall diagrams showing:
- Which operations ran in parallel
- Which operations were sequential
- Where time was spent (exclusive duration)

**2. Performance Attribution:**

```
Root: GET /api/users (2415ms total)
├─ child-db-query (642ms)  ← 26% of total time
└─ child-transform (1764ms) ← 73% of total time
```

**3. Trace Analysis:**

- Identify slow operations
- Detect N+1 query patterns
- Find parallelization opportunities
- Calculate exclusive vs inclusive time


---

## Key Differences Summary

| Feature | Events | Links | Children |
|---------|--------|-------|----------|
| **What** | Time-stamped annotations | Cross-trace span references | Hierarchical child spans |
| **Scope** | Within a single span | Across different traces | Within the same trace |
| **Data Structure** | `{ name, timestamp, attributes }` | `{ traceId, spanId, attributes }` | Full `AggregatedSpan` objects |
| **Purpose** | Mark moments in time | Model non-parent relationships | Build trace tree |
| **Where** | `SpanEvent` and `AggregatedSpan` | `SpanEvent` and `AggregatedSpan` | **Only** in `TraceEvent` |
| **Typical Count** | 0-10 per span | 0-100+ (batch jobs) | 0-1000+ (trace depth) |
| **User API** | `span.addEvent()` | `span.addLink()` | Automatic (via `parentSpanId`) |
| **Empty Default** | `[]` | `[]` | `[]` |

---

## Code Reference Summary

### Type Definitions

```typescript
// sdk-node/src/types/event.ts:125-129
interface SpanEventItem {
  readonly name: string
  readonly timestamp: number
  readonly attributes?: Readonly<Record<string, unknown>>
}

// sdk-node/src/types/event.ts:131-134
interface SpanLink {
  readonly traceId: string
  readonly spanId: string
}

// sdk-node/src/tracing/trace-aggregator.ts:61-75
interface AggregatedSpan {
  readonly spanId: string
  readonly parentSpanId?: string
  // ... other fields ...
  readonly events?: readonly SpanEventItem[]
  readonly links?: readonly SpanLink[]
  readonly children: AggregatedSpan[]  // Recursive
}
```


### User API

```typescript
// Add event to span
// sdk-node/src/tracing/span.ts:175-187
span.addEvent(name: string, attributes?: Attributes): this

// Add link to span
// sdk-node/src/tracing/span.ts:189-200
span.addLink(link: SpanLink): this
span.addLinks(links: SpanLink[]): this

// Children are built automatically by TraceAggregator
// No user API for children - they're derived from parentSpanId relationships
```

### Exporter Logic

```typescript
// Extract events and links from OTel span
// sdk-node/src/tracing/tracer.ts:330-337
events: span.events.map(e => ({
    name: e.name,
    timestamp: hrTimeToMs(e.time),
    attributes: e.attributes,
})),
links: span.links.map(l => ({
    traceId: l.context.traceId,
    spanId: l.context.spanId,
    attributes: l.attributes,
})),
```

### Aggregation Logic

```typescript
// Build children hierarchy
// sdk-node/src/tracing/trace-aggregator.ts:290-313
private buildTree(
  rootEvent: Record<string, unknown>,
  childrenByParent: ReadonlyMap<string, Record<string, unknown>[]>,
): AggregatedSpan {
  const children = (childrenByParent.get(rootSpanId) ?? [])
    .map(child => this.buildTree(child, childrenByParent))
  
  return {
    // ... span fields ...
    children,  // Recursive
  }
}
```

---

## FAQ


### Q: Why don't individual span events have `children`?

**A:** Individual spans are exported independently by OpenTelemetry's `BatchSpanProcessor`. The SDK doesn't know about child spans until they're all collected. The `TraceAggregator` buffers spans and reconstructs the hierarchy when the root span arrives. Only the aggregated `TraceEvent` (type: 'trace') contains the full tree.

### Q: How do I know if a span has children?

**A:** 
- In individual `SpanEvent`: Check if other spans have `parentSpanId` matching this span's `spanId`
- In aggregated `TraceEvent`: Check if `children` array is non-empty

### Q: Can events contain references to other spans?

**A:** No. Events are annotations **within** a single span. Use `links` to reference other spans.

### Q: Can links reference spans in the same trace?

**A:** Technically yes, but it's not the intended use case. Same-trace relationships should use parent-child hierarchy (`parentSpanId` / `children`). Links are for **cross-trace** relationships.

### Q: What's the difference between `parentSpanId` and `children`?

**A:**
- `parentSpanId`: A single string pointing to the immediate parent (bottom-up reference)
- `children`: An array of full child span objects (top-down containment)

Both represent the same relationship, just from different directions.

### Q: Why are links rare in production traces?

**A:** Most operations follow simple parent-child hierarchies within a single trace. Links are only needed for advanced patterns like batch processing, queue consumers, or distributed sagas that span multiple traces.


### Q: Are `events` and `links` included in aggregated traces?

**A:** Yes. When the `TraceAggregator` builds the trace tree, each `AggregatedSpan` includes the `events` and `links` arrays from the original span. The aggregation only adds the `children` array; it doesn't remove existing data.

### Q: What's the difference between ERROR events and error spans?

**A:**
- **ERROR events** (type: 'error'): Separate events with `severity` field (info, warning, error, fatal). Used for application errors, exceptions, crashes.
- **Error spans** (type: 'span' with status: 'error'): Failed operations in tracing. Spans have `status` field ('ok', 'error', 'unset').
- A failed span often records an `exception` event in its `events` array, but they are distinct concepts.
- Example: `{ type: "error", severity: "error", ... }` vs `{ type: "span", status: "error", events: [{ name: "exception", ... }] }`

### Q: What happens if the root span never arrives?

**A:** After 30 seconds (default `orphanTimeoutMs`), the `TraceAggregator` flushes the buffered spans as a **partial trace** with `isPartial: true`. The earliest span by `startTime` becomes the synthetic root.

### Q: Can I add events or links after a span ends?

**A:** No. Once `span.end()` is called, the span is marked as ended and all mutation methods become no-ops. Events and links must be added during span execution.

---

## Visualization Examples

### Span Timeline with Events

```
Span: parent-operation (2415ms)
│
├─ 0ms       [span starts]
├─ 431ms     ⭐ pulse.profile.start
├─ 642ms     [child-db-query completes]
├─ 2406ms    [child-transform completes]
└─ 2415ms    [span ends]
```

### Trace Hierarchy (Children)

```
GET /api/users (2420ms)
│
└─ parent-operation (2415ms)
   ├─ child-db-query (642ms)
   │  └─ (no children)
   │
   └─ child-transform (1764ms)
      └─ (no children)
```


### Cross-Trace Links (Batch Job)

```
Trace 1: Order 12345
└─ process-order (1000ms)

Trace 2: Order 67890  
└─ process-order (1200ms)

Trace 3: Batch Job
└─ process-order-batch (2500ms)
   │
   ├─ Link → Trace 1, Span: process-order
   └─ Link → Trace 2, Span: process-order
```

---

## Conclusion

### Quick Reference

- **`events`**: Time-stamped annotations WITHIN a span (e.g., profiling start, exceptions, cache hits)
- **`links`**: References to spans in OTHER traces (e.g., batch processing, queue consumers)
- **`children`**: Hierarchical tree of child spans WITHIN the same trace (for waterfall visualization)

### When to Use Each

| Need | Use |
|------|-----|
| Mark a moment in time | `events` |
| Reference another trace | `links` |
| Visualize operation hierarchy | `children` (automatic) |

### Data Flow

```
1. User creates spans with parent-child relationships
   ↓
2. User adds events and links during execution
   ↓
3. Spans export individually with events + links
   ↓
4. TraceAggregator buffers spans by traceId
   ↓
5. Root span arrives → triggers aggregation
   ↓
6. buildTree() constructs children hierarchy
   ↓
7. TraceEvent emitted with full tree
```

---

**End of Documentation**
