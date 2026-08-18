# Trace Event parentSpanId Analysis

**Date:** August 1, 2026  
**Question:** Does the SDK send `parentSpanId` in trace events?  
**Answer:** ✅ **YES - Definitively confirmed**

---

## Executive Summary

**YES**, the SDK **DOES send `parentSpanId`** in trace events. It is included in **every aggregated span** within the trace hierarchy.

---

## Evidence from Source Code

### Location: `src/tracing/trace-aggregator.ts`

### 1. Type Definition (Line 39)

```typescript
/** A span with its reconstructed children hierarchy. */
export interface AggregatedSpan {
  readonly spanId: string
  readonly parentSpanId?: string | undefined  // ← YES, included here!
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

**✅ CONFIRMED:** `parentSpanId` is declared in the `AggregatedSpan` interface.

---

### 2. Tree Building (Line 311)

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
      parentSpanId: rootEvent.parentSpanId as string | undefined,  // ← Extracted from span event!
      name: rootEvent.name as string,
      kind: rootEvent.kind as string | undefined,
      startTime: rootEvent.startTime as number,
      endTime: rootEvent.endTime as number,
      duration: rootEvent.duration as number,
      exclusiveDuration: rootEvent.exclusiveDuration as number | undefined,
      status: rootEvent.status as string,
      statusMessage: rootEvent.statusMessage as string | undefined,
      attributes: rootEvent.attributes as Record<string, unknown> | undefined,
      events: rootEvent.events as AggregatedSpan['events'],
      links: rootEvent.links as AggregatedSpan['links'],
      children,
    }
  }
```

**✅ CONFIRMED:** `parentSpanId` is explicitly extracted from the span event and included in the returned `AggregatedSpan`.

---

### 3. Parent-Child Indexing (Line 248-257)

```typescript
// Build the tree. Index children by parentSpanId once (O(n)) instead
// of filtering the full span list at every recursion level (O(n²)) —
// traces with thousands of spans would otherwise stall the event loop.
const childrenByParent = new Map<string, Record<string, unknown>[]>()
for (const span of spans) {
    const parentId = span.parentSpanId as string | undefined  // ← Read from span!
    if (!parentId) continue  // Skip root spans
    const list = childrenByParent.get(parentId)
    if (list) {
      list.push(span)
    } else {
      childrenByParent.set(parentId, [span])
    }
}
```

**✅ CONFIRMED:** The aggregator explicitly uses `parentSpanId` to build the parent-child index.

---

### 4. Root Span Detection (Line 177-179)

```typescript
// Root span detection: no parentSpanId means this is the root.
if (!parentSpanId) {
    trace.rootSpan = spanEvent
}
```

**✅ CONFIRMED:** Root span identification relies on `parentSpanId` being `undefined` or `null`.

---

## Complete Trace Event Structure

### What Gets Sent to Backend

```json
{
  "type": "trace",
  "eventId": "trace_4bf92f3577b34da6a3ce929d0e0e4736",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanCount": 5,
  "totalDuration": 845,
  "isPartial": false,
  "rootSpan": {
    "spanId": "00f067aa0ba902b7",
    "parentSpanId": null,                    // ← Root has no parent
    "name": "GET /api/users/:id",
    "duration": 845,
    "children": [
      {
        "spanId": "11g178bb1cb013c8",
        "parentSpanId": "00f067aa0ba902b7",  // ← Child references parent!
        "name": "db.query",
        "duration": 600,
        "children": [
          {
            "spanId": "22h289cc2dc124d9",
            "parentSpanId": "11g178bb1cb013c8",  // ← Grandchild references parent!
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

---

## Verification at Every Level

### Level 1: Root Span
```json
{
  "spanId": "00f067aa0ba902b7",
  "parentSpanId": null  // ✅ Root has no parent
}
```

### Level 2: Direct Child
```json
{
  "spanId": "11g178bb1cb013c8",
  "parentSpanId": "00f067aa0ba902b7"  // ✅ References root
}
```

### Level 3: Grandchild
```json
{
  "spanId": "22h289cc2dc124d9",
  "parentSpanId": "11g178bb1cb013c8"  // ✅ References parent child
}
```

---

## How parentSpanId Flows Through SDK

### Step 1: Span Creation (OTel)
```
OpenTelemetry creates span
    ↓
Span has parentSpanContext with parent's spanId
    ↓
Stored in span.parentSpanContext.spanId
```

### Step 2: Span Export (tracer.ts:246)
```typescript
const parentSpanId = span.parentSpanContext?.spanId

return {
    type: 'span',
    spanId: ctx.spanId,
    traceId: ctx.traceId,
    parentSpanId,  // ← Included in span event
    // ...
}
```

### Step 3: Trace Aggregation (trace-aggregator.ts:150)
```typescript
addSpan(spanEvent: Record<string, unknown>): void {
    const parentSpanId = spanEvent.parentSpanId as string | undefined
    // ... use parentSpanId to detect root and build tree
}
```

### Step 4: Tree Building (trace-aggregator.ts:311)
```typescript
return {
    spanId: rootSpanId,
    parentSpanId: rootEvent.parentSpanId as string | undefined,  // ← Preserved!
    children,
}
```

### Step 5: Sent to Backend
```
TraceEvent with rootSpan → includes parentSpanId in every span node
```

---

## Why parentSpanId is Critical

### 1. **Hierarchy Reconstruction**
Backend needs `parentSpanId` to reconstruct the tree even if spans arrive out of order.

### 2. **Validation**
Backend can verify that:
- `parentSpanId` references valid span in same trace
- No circular references exist
- Tree structure is valid

### 3. **Redundancy**
Even though the SDK sends a pre-built tree with `children` arrays, having `parentSpanId` allows backend to:
- Rebuild tree if corruption occurs
- Validate SDK-built tree
- Support different storage models

### 4. **Compatibility**
Other observability tools expect `parentSpanId` in every span for OpenTelemetry compliance.

---

## Test Cases

### Test Case 1: Simple Parent-Child
```
Root Span (spanId: A, parentSpanId: null)
  └─ Child Span (spanId: B, parentSpanId: A)
```

**Expected Trace Event:**
```json
{
  "rootSpan": {
    "spanId": "A",
    "parentSpanId": null,
    "children": [
      {
        "spanId": "B",
        "parentSpanId": "A"  // ✅
      }
    ]
  }
}
```

### Test Case 2: Deep Nesting
```
Root (spanId: A)
  └─ Child1 (spanId: B, parentSpanId: A)
      └─ Grandchild (spanId: C, parentSpanId: B)
          └─ Great-grandchild (spanId: D, parentSpanId: C)
```

**Expected Trace Event:**
```json
{
  "rootSpan": {
    "spanId": "A",
    "parentSpanId": null,
    "children": [
      {
        "spanId": "B",
        "parentSpanId": "A",  // ✅
        "children": [
          {
            "spanId": "C",
            "parentSpanId": "B",  // ✅
            "children": [
              {
                "spanId": "D",
                "parentSpanId": "C"  // ✅
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### Test Case 3: Multiple Children
```
Root (spanId: A)
  ├─ Child1 (spanId: B, parentSpanId: A)
  ├─ Child2 (spanId: C, parentSpanId: A)
  └─ Child3 (spanId: D, parentSpanId: A)
```

**Expected Trace Event:**
```json
{
  "rootSpan": {
    "spanId": "A",
    "parentSpanId": null,
    "children": [
      { "spanId": "B", "parentSpanId": "A" },  // ✅
      { "spanId": "C", "parentSpanId": "A" },  // ✅
      { "spanId": "D", "parentSpanId": "A" }   // ✅
    ]
  }
}
```

---

## Comparison: Span Events vs Trace Events

### Individual Span Events (Sent Before Aggregation)
```json
[
  {
    "type": "span",
    "spanId": "A",
    "parentSpanId": null  // ✅ Included
  },
  {
    "type": "span",
    "spanId": "B",
    "parentSpanId": "A"  // ✅ Included
  }
]
```

### Aggregated Trace Event (Sent After Aggregation)
```json
{
  "type": "trace",
  "rootSpan": {
    "spanId": "A",
    "parentSpanId": null,  // ✅ Still included
    "children": [
      {
        "spanId": "B",
        "parentSpanId": "A"  // ✅ Still included
      }
    ]
  }
}
```

**✅ CONFIRMED:** `parentSpanId` is preserved in BOTH span events and trace events.

---

## Conclusion

### ✅ **Definitive Answer: YES**

1. **Type Declaration:** `parentSpanId` is in `AggregatedSpan` interface
2. **Tree Building:** `parentSpanId` is explicitly extracted and included
3. **Indexing Logic:** `parentSpanId` is used to build parent-child relationships
4. **Root Detection:** Absence of `parentSpanId` identifies root spans
5. **Export:** Every span in trace hierarchy includes `parentSpanId`

### Values

- **Root spans:** `parentSpanId = null` or `undefined`
- **Child spans:** `parentSpanId = <parent's spanId>`
- **Format:** 16-character hexadecimal string

### Why This Matters

- ✅ Backend can validate tree structure
- ✅ Backend can rebuild tree if needed
- ✅ Complies with OpenTelemetry conventions
- ✅ Enables cross-span analysis
- ✅ Supports distributed tracing standards

---

**Final Answer:** Your SDK **DOES send `parentSpanId`** in trace events. It is included in every aggregated span within the trace hierarchy, allowing backends to understand and validate the parent-child relationships even though the spans are already organized in a nested `children` structure.
