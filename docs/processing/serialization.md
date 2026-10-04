# Serialization Architecture

## 1. Overview

Serializing large arrays of trace spans or error events to JSON can consume significant CPU cycles. If executed synchronously on Node.js's single main thread, `JSON.stringify()` on multi-megabyte payloads can stall the event loop for 50–200ms, causing latency spikes in customer HTTP request handling.

Pulse prevents event-loop stalls through a hybrid serialization architecture:
- **Small Payloads (< 50 KB):** Serialized synchronously on the main thread (< 1ms).
- **Large Payloads (>= 50 KB):** Offloaded to worker threads via `SerializationPool` ([`src/transport/serialization-pool.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-pool.ts)).

---

## 2. Threshold Evaluation

The offloading decision occurs during batch assembly in `BatchManager`:

```
Batch Assembled for Dispatch
             |
             v
   Estimate Payload Size
             |
             +-------------------------------+
             |                               |
        < 50 KB                          >= 50 KB
             |                               |
             v                               v
Synchronous Fast JSON           Dispatch to Worker Thread
Stringify on Main Thread       (worker_threads SerializationPool)
             |                               |
             +---------------+---------------+
                             |
                             v
                  Compressed & Transmitted
```

---

## 3. Circular Reference & Type Safety

Standard `JSON.stringify` throws a `TypeError: Converting circular structure to JSON` if an object references itself.

Pulse uses a resilient serializer that handles:
- **Circular References:** Converted to `"[Circular]"`.
- **BigInt Support:** `BigInt` values serialized to strings.
- **Buffers & ArrayBuffers:** Converted to base64 or length indicators.
- **Functions & Symbols:** Stripped cleanly without errors.
