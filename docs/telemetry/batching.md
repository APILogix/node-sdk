# Telemetry Batching & Flush Windows

## 1. Overview

The `BatchManager` in [`src/transport/batch-manager.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts) aggregates individual events into structured payload batches for network transmission. 

Batching minimizes network connection overhead, optimizes HTTP keep-alive socket efficiency, and reduces TLS renegotiation costs.

---

## 2. Route-Specific Batch Configuration

Different telemetry types have different latency tolerances. Pulse configures dedicated batch sizes and flush timers per route:

| Route | Default Batch Size | Default Flush Interval | Priority |
|---|---|---|---|
| **`errors`** | 100 items | 1,000 ms (1 sec) | Critical |
| **`traces`** | 500 items | 5,000 ms (5 sec) | High |
| **`spans`** | 500 items | 5,000 ms (5 sec) | High |
| **`requests`** | 500 items | 5,000 ms (5 sec) | High |
| **`crons`** | 1 item | Immediate (0 ms) | High |
| **`events`** | 50 items | 5,000 ms (5 sec) | Normal |
| **`metrics`** | 1,000 items | 10,000 ms (10 sec) | Normal |
| **`logs`** | 200 items | 10,000 ms (10 sec) | Normal |
| **`profiles`** | 5 items | 30,000 ms (30 sec) | Low |
| **`replays`** | 5 items | 10,000 ms (10 sec) | Low |

---

## 3. Flush Triggers

A batch is dispatched to the network when **either** condition is met:
1. **Capacity Threshold:** The number of buffered items for that route reaches `batchSize`.
2. **Timer Window:** The elapsed time since the oldest un-flushed event exceeds `flushIntervalMs`.

### Timer Unref Safety:
All periodic flush timers invoke `.unref()` so they do not artificially keep the Node.js event loop alive when the customer application is idle.

---

## 4. Manual & Emergency Flushes

### 4.1 Programmatic Flush (`flush`)
Applications running serverless or short-lived jobs can force an asynchronous flush of all routes before ending the execution:

```typescript
import { flush } from '@pulse-apm/node';

await flush(2000); // 2-second timeout deadline
```

### 4.2 Emergency Crash Flush (`crashFlush`)
When an uncaught exception triggers process exit, `crashFlush(timeoutMs)` attempts an immediate synchronous or high-priority transmission of fatal error events before the V8 isolate terminates.
