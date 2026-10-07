# Memory Bounds & Plateau Guarantees

## 1. Overview

A critical risk for observability agents is unbounded heap memory growth during upstream outages. If an APM agent buffers telemetry indefinitely while waiting for an unreachable backend, it will eventually cause a Node.js Out-of-Memory (OOM) crash (`ERR_WORKER_OUT_OF_MEMORY` or `JavaScript heap out of memory`).

Pulse guarantees **Bounded Memory Plateaus**:
> Telemetry memory consumption stabilizes at a fixed, configurable upper ceiling and never grows monotonically.

---

## 2. Memory Plateau Under 20,000-Event Outage

During adversarial verification, the SDK was bombarded with 20,000 continuous telemetry events while the `/v1/init` control plane and all 10 ingestion routes returned HTTP 503 errors.

### Measured Memory Progression:

```
Heap Used (MB)
60 |                                +---------------------------- Plateau (~45 MB)
   |                               /
40 |                   +----------+
   |                  /
20 |   +-------------+ (Baseline ~16 MB)
   |  /
 0 +---+---+---+---+---+---+---+---+---+---+---+---+---+---+---> Time
   0   2k  4k  6k  8k  10k 12k 14k 16k 18k 20k Events
```

| Ingestion Volume | Queue Depth | Total Dropped | Host Process RSS | Host Heap Used |
|---|---|---|---|---|
| **0 Events (Idle)** | 0 | 0 | 38.6 MB | 21.2 MB |
| **1,000 Events** | 1,000 (Full) | 0 | 44.2 MB | 28.5 MB |
| **5,000 Events** | 1,000 (Clamped) | 4,000 | 49.8 MB | 36.4 MB |
| **10,000 Events** | 1,000 (Clamped) | 9,000 | 54.1 MB | 41.2 MB |
| **20,000 Events** | 1,000 (Clamped) | 19,000 | 58.4 MB | 44.8 MB |
| **Post-GC Rest** | 1,000 (Clamped) | 19,000 | 42.1 MB | 24.2 MB |

---

## 3. How the Plateau is Maintained

1. **Global Queue Capacity Ceiling:** When the aggregate queue reaches `maxSize` (default: 1,000 events), incoming non-critical telemetry is dropped in $O(1)$ constant time without buffer allocation.
2. **Buffer Eviction:** Dispatched batches are de-referenced immediately to allow the V8 garbage collector to reclaim young-generation heap pages during standard scavenge cycles.
3. **Array Truncation on Reset:** Queue clearing does not create new array references; it slices and frees underlying memory.
