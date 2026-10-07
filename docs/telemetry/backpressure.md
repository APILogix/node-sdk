# Backpressure & Load Shedding

## 1. Overview

Observability agents must protect the host process from memory exhaustion (OOM crashes) during traffic spikes or downstream network delays. 

The Pulse SDK incorporates a multi-layer backpressure architecture:
- **Memory Pressure Monitor:** [`src/utils/backpressure.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/backpressure.ts)
- **Quota Controller:** [`src/core/quota-controller.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/quota-controller.ts)
- **Load Shedder:** [`src/transport/load-shedder.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/load-shedder.ts)

---

## 2. Memory Pressure Monitor

The `MemoryPressureMonitor` samples Node.js memory metrics:
- `v8.getHeapStatistics()`: Heap size, heap limit, and heap utilization.
- `process.memoryUsage()`: RSS, external memory, array buffers.
- Linux cgroups v1 / v2 container memory limits (when running in Docker or Kubernetes).

### Thresholds:
- **Normal:** Heap utilization < 75%. Telemetry flows without restriction.
- **Elevated:** Heap utilization between 75% and 85%. Sampling rates throttled.
- **Critical:** Heap utilization > 85%. Routine logs and metrics dropped; only critical errors admitted to `EventQueue`.

---

## 3. Load Shedder Architecture

When `EventQueue` fill ratio exceeds 80% or memory pressure reaches `Critical`, the `LoadShedder` activates progressive shedding:

```
Telemetry Load Increasing
-------------------------------------------------------------------->
[ 100% Admission ]
        |
        v  (Queue > 75% full)
[ Shed Normal Tier: Metrics & Debug Logs dropped ]
        |
        v  (Queue > 90% full)
[ Shed High Tier: Non-error Spans & HTTP Requests dropped ]
        |
        v  (Queue at 1000 Capacity Ceiling)
[ Evict Lower Priority / Drop non-critical: Critical Errors Retained ]
```

---

## 4. Quota Exhaustion (HTTP 429) Handling

When the ingestion control plane returns an HTTP 429 response indicating that the tenant's ingestion quota is exhausted:
1. `QuotaController.markExhausted(retryAfterSeconds)` activates.
2. Ingestion routes transition to `QUOTA_EXHAUSTED` state.
3. Outbound network requests for non-critical routes are suspended for the duration of the backoff interval, preventing wasteful socket utilization.
4. Dropped event counters are tracked and reported in `getSDKHealth()`.
