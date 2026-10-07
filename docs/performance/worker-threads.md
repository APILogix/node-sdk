# Worker Threads & Serialization Pool

## 1. Why Worker Threads?

In high-throughput environments, JSON stringification and Gzip compression of large telemetry batches (e.g., 500 spans = 2–5MB uncompressed JSON) can block the single Node.js main thread for up to 50ms.

Pulse resolves this by offloading serialization and compression to background worker threads using Node.js native `worker_threads`.

The worker pool implementation resides in:
- Pool Coordinator: [`src/transport/serialization-pool.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-pool.ts)
- Thread Worker Script: [`src/transport/serialization-worker.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-worker.ts)

---

## 2. Pool Architecture & Sizing

```
                      Main Thread
              (Assembles Telemetry Batch)
                           |
                           v  Payload >= 50 KB
             +---------------------------+
             |    SerializationPool      |
             | (Task Queue: Max 50 items)|
             +---------------------------+
               /                       \
              /                         \
             v                           v
     +---------------+           +---------------+
     | Worker Thread |           | Worker Thread |
     |      #1       |           |      #2       |
     +---------------+           +---------------+
      - JSON stringify            - JSON stringify
      - Gzip compress             - Gzip compress
             \                           /
              \                         /
               v                       v
             Zero-Copy ArrayBuffer Transfer
                           |
                           v
                      Main Thread
              (Dispatches HTTP Request)
```

### Worker Sizing Rules:
- **Default Worker Count:** 1 worker (or up to $\min(2, \text{os.cpus().length} / 2)$).
- **Conservative Allocation:** Pulse deliberately limits worker thread count to prevent stealing CPU cores needed by the customer's application threads.

---

## 3. Communication Protocol & Zero-Copy Transfers

1. **Job Dispatch:** The main thread sends the raw batch object to the worker via `worker.postMessage({ id, type: 'serialize_compress', payload, options })`.
2. **Worker Processing:** The worker thread executes fast JSON serialization and `zlib.gzipSync`.
3. **Zero-Copy Response:** The resulting compressed `Buffer` is transferred back to the main thread utilizing `postMessage(response, [buffer.buffer])`. The underlying memory buffer is transferred rather than cloned, eliminating secondary allocation overhead.

---

## 4. Crash Containment & Shutdown

### 4.1 Worker Crash Recovery
If a worker thread encounters an out-of-memory error or unexpected termination:
- The pool catches the `worker.on('error')` or `worker.on('exit')` event.
- In-flight tasks assigned to that worker are caught and resolved with fallback uncompressed main-thread serialization.
- A fresh replacement worker is spawned lazily on demand.
- **The host application never crashes.**

### 4.2 Graceful Shutdown
When `shutdown()` is called:
- `serializationPool.terminate()` stops accepting new jobs.
- Active worker tasks are allowed up to 1,000ms to complete.
- `worker.terminate()` is called, immediately releasing OS thread handles.
