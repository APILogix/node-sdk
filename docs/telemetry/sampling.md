# Dynamic Adaptive Sampling

## 1. Overview

In high-throughput distributed microservices, capturing 100% of non-error traces and database queries creates excessive network egress and ingestion costs.

The Pulse SDK implements **Dynamic Adaptive Sampling** ([`src/tracing/remote-config-sampler.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/remote-config-sampler.ts)), combining control-plane configured base rates with local system pressure awareness.

---

## 2. Multi-Dimensional Pressure States

The SDK continuously computes an aggregate system pressure score ($0.0$ to $1.0$) based on:
- Event-loop delay lag (`perf_hooks`)
- Node.js heap memory utilization vs cgroup/container limits
- EventQueue fill ratio

Based on this score, the SDK transitions between four pressure states:

| Pressure State | Score Range | Trace Sampling Rate | Log Sampling Rate |
|---|---|---|---|
| **`HEALTHY`** | 0.00 – 0.40 | 100% (or configured base) | 100% |
| **`ELEVATED`** | 0.41 – 0.65 | 80% | 75% |
| **`PRESSURED`** | 0.66 – 0.85 | 50% | 30% |
| **`CRITICAL`** | 0.86 – 1.00 | 10% | 5% |

---

## 3. Priority Error Preservation

A common failure mode in standard APM agents is dropping critical failure traces when sampling rates drop under high load.

Pulse implements **Priority Error Preservation**:
1. **Fatal Errors:** Uncaught exceptions and unhandled promise rejections **completely bypass** adaptive sampling. They are guaranteed 100% capture regardless of system pressure.
2. **HTTP 5xx Server Errors:** Traces containing HTTP 5xx responses or unhandled database exceptions are retroactively promoted to priority retention.
3. **Reserved Capacity:** The `EventQueue` reserves dedicated capacity for critical tier events, ensuring error telemetry is never shed to make room for routine 200 OK traces.
