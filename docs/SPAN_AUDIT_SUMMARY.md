# Span Propagation Audit - Executive Summary

**Date:** August 1, 2026  
**SDK:** Pulse Node.js SDK v1.0.0  
**Verdict:** ✅ **PASS WITH CRITICAL FINDINGS**

---

## Overview

Comprehensive audit of span creation, propagation, and parent-child relationships across all SDK code paths.

**Full Report:** `SPAN_PROPAGATION_AUDIT.md`

---

## Key Findings

### ✅ What Works Correctly

1. **OpenTelemetry Integration** - Fully compliant with OTel spec
2. **W3C Trace Context** - Correct distributed tracing propagation
3. **Parent-Child Linkage** - Accurate `parentSpanId` in exports
4. **Context Isolation** - AsyncLocalStorage prevents cross-request contamination
5. **Auto-Instrumentation** - HTTP, Express, databases correctly instrumented
6. **Trace Aggregation** - Hierarchical traces correctly reconstructed

### ❌ Critical Issues (Must Fix)

| Issue | Severity | Impact |
|-------|----------|--------|
| `startSpan()` doesn't activate context | 🔴 CRITICAL | Child spans won't link to manual parents |
| Trace aggregator memory leak | 🔴 CRITICAL | Memory accumulation on aggregation errors |
| Cost governor orphans children | 🟡 HIGH | Backend receives incomplete traces |
| EventEmitter patch optional | 🟡 HIGH | Event handlers lose trace context |

---

## Does SDK Send parentSpanId?

### ✅ YES - Verified in Multiple Locations

1. **SpanEvent Export:**
   ```json
   {
     "type": "span",
     "spanId": "00f067aa0ba902b7",
     "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
     "parentSpanId": "b1f067aa0ba902b8"  ← YES, sent!
   }
   ```

2. **TraceEvent Export:**
   ```json
   {
     "type": "trace",
     "rootSpan": {
       "spanId": "root123",
       "parentSpanId": null,  ← Root has no parent
       "children": [{
         "spanId": "child456",
         "parentSpanId": "root123"  ← Child references parent
       }]
     }
   }
   ```

3. **Source:**
   - Extracted from `span.parentSpanContext?.spanId` (OTel)
   - File: `src/tracing/tracer.ts:246`
   - Used in export: Line 250

---

## ID Generation

| ID Type | Format | Generator | Example |
|---------|--------|-----------|---------|
| traceId | 32-char hex | OpenTelemetry | `4bf92f3577b34da6...` |
| spanId | 16-char hex | OpenTelemetry | `00f067aa0ba902b7` |
| eventId | UUID v4 | Node crypto | `550e8400-e29b-41d4...` |

**All are STRINGS, not numbers!**

---

## Critical Code Paths Verified

### ✅ HTTP Request → Span Creation
```
1. HttpInstrumentation creates SERVER span
2. parentSpanId extracted from traceparent header (or null for root)
3. Express middleware enriches active span
4. Child operations (DB, Redis) create spans with parentSpanId = active span
5. All spans exported with correct parent references
```

### ✅ Manual Span Creation
```
withSpan('parent', async (parent) => {
  // parent.parentSpanId = undefined (root)
  
  await withSpan('child', async (child) => {
    // child.parentSpanId = parent.spanId ✅
  })
})
```

### ⚠️ startSpan() Issue
```typescript
const parent = startSpan('parent')  // NOT active!
const child = startSpan('child')    // Won't link to parent ❌
```

---

## Immediate Actions Required

### 1. Document startSpan() Behavior (Critical)

**Current docstring is misleading:**
```typescript
/**
 * Start a new span and return a PulseSpan wrapper.
 * ⚠️ ADD THIS WARNING:
 * This span is NOT made active. Use withSpan() for context propagation.
 */
```

### 2. Fix Memory Leak (Critical)

**File:** `src/tracing/trace-aggregator.ts:286`
```typescript
} catch (err) {
    logger.error('Failed to aggregate trace', { traceId, error: err })
    spanDurationTracker.cleanupTrace(traceId)  // ← ADD THIS
}
```

### 3. Add Validation (High)

**File:** `src/tracing/tracer.ts:246`
```typescript
const parentSpanId = span.parentSpanContext?.spanId
const parentTraceId = span.parentSpanContext?.traceId

// Validate parent belongs to same trace
if (parentTraceId && parentTraceId !== ctx.traceId) {
    logger.warn('Cross-trace parent detected', { parentTraceId, traceId })
    parentSpanId = undefined  // Break invalid link
}
```

---

## Testing Recommendations

### Test Case 1: Nested Spans
```typescript
await withSpan('root', async (root) => {
    assert(root.parentSpanId === undefined)
    
    await withSpan('child', async (child) => {
        assert(child.parentSpanId === root.spanId)
        
        await withSpan('grandchild', async (gc) => {
            assert(gc.parentSpanId === child.spanId)
        })
    })
})
```

### Test Case 2: Context Preservation
```typescript
withSpan('parent', async (parent) => {
    setTimeout(() => {
        const currentTrace = getTraceId()
        assert(currentTrace === parent.traceId)
    }, 100)
})
```

### Test Case 3: Event Correlation
```typescript
withSpan('span', async (span) => {
    try {
        throw new Error('test')
    } catch (err) {
        captureError(err)
        // Verify error has span.spanId and span.traceId
    }
})
```

---

## Conclusion

**The SDK correctly implements parentSpanId throughout the codebase.**

✅ Trace IDs are 32-char hex strings  
✅ Span IDs are 16-char hex strings  
✅ Event IDs are UUID v4 strings  
✅ parentSpanId is sent in all span exports  
✅ Root spans have parentSpanId = undefined  
✅ Child spans have parentSpanId = parent's spanId  

**However:** Critical documentation and edge case issues require immediate attention.

**Next Steps:**
1. Apply critical fixes
2. Add integration tests for parent-child verification
3. Document limitations (startSpan, worker threads)
4. Consider making EventEmitter patch mandatory

---

**For detailed analysis, see:** `SPAN_PROPAGATION_AUDIT.md`
