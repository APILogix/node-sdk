# Deduplication & Fingerprinting

## 1. Overview

In production microservices, a recurring downstream dependency failure (e.g., database connection timeout) can emit thousands of identical error events within seconds, saturating memory and transport pipelines.

The Pulse SDK features automated deduplication engines for both errors and traces:
- **Error Deduplication:** [`src/processors/deduplicator.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/deduplicator.ts)
- **Stack Trace Fingerprinting:** [`src/processors/fingerprint.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/fingerprint.ts)
- **Trace Deduplication:** LRU trace ID cache to eliminate duplicate span submissions.

---

## 2. Deterministic Fingerprint Calculation

When `captureError(err)` is invoked:
1. The error's stack trace is parsed into normalized V8 `StackFrame` objects via `StackParser` ([`src/processors/stack-parser.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/stack-parser.ts)).
2. Volatile attributes (line numbers, column numbers, variable memory addresses) are stripped.
3. The error class name, top non-node_modules function names, and normalized file paths are hashed (SHA-256) into a stable **Fingerprint**:

$$\text{fingerprint} = \text{hash}(\text{error.name} + \text{frame[0].function} + \text{frame[0].file} + \dots)$$

---

## 3. Sliding Window Deduplication

The `ErrorDeduplicator` maintains an in-memory LRU cache of recently observed fingerprints:

```typescript
// Algorithm in src/processors/deduplicator.ts
public shouldEmit(fingerprint: string, windowMs = 5000): { emit: boolean; duplicateCount: number } {
  const existing = this.cache.get(fingerprint);
  const now = Date.now();

  if (existing && (now - existing.timestamp) < windowMs) {
    existing.count++;
    return { emit: false, duplicateCount: existing.count };
  }

  this.cache.set(fingerprint, { timestamp: now, count: 1 });
  return { emit: true, duplicateCount: 1 };
}
```

### Behavior:
- **First Occurrence:** Emitted immediately with `duplicateCount: 1`.
- **Subsequent Identical Occurrences (within window):** Suppressed from the network queue; internal occurrence counter increments.
- **Window Expiry:** When the window expires, the next event is emitted containing the aggregated `duplicateCount` metadata attribute, preserving accurate occurrence totals without flooding the transport layer.
