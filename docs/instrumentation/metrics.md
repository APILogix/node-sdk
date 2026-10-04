# Metrics Subsystem & OpenTelemetry MetricReader

## 1. Overview

The metrics subsystem in [`src/metrics/registry.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/metrics/registry.ts) provides high-throughput metric aggregation. It integrates with `@opentelemetry/sdk-metrics` through a custom reader ([`src/metrics/pulse-metric-reader.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/metrics/pulse-metric-reader.ts)).

---

## 2. Supported Metric Instruments

Pulse supports four standard metric instrument types:

| Instrument | Public API | Purpose | Example |
|---|---|---|---|
| **Counter** | `incrementCounter(name, value, tags)` | Monotonically increasing total. | Total HTTP requests, signups. |
| **Gauge** | `setGauge(name, value, tags)` | Point-in-time instantaneous measurement. | Active WebSocket connections, queue depth. |
| **Histogram** | `recordHistogram(name, value, tags)` | Statistical distribution of numerical values. | Query execution latency, payload bytes. |
| **UpDownCounter** | `addUpDownCounter(name, delta, tags)` | Bidirectional counter. | In-flight tasks, concurrent threads. |

---

## 3. Usage Examples

```typescript
import {
  incrementCounter,
  setGauge,
  recordHistogram,
  addUpDownCounter,
} from '@pulse-apm/node';

// 1. Increment a counter
incrementCounter('orders.completed', 1, { plan: 'enterprise', country: 'US' });

// 2. Set an active gauge
setGauge('cache.active_keys', 42100, { cluster: 'redis-primary' });

// 3. Record a latency histogram
recordHistogram('image_processing.latency_ms', 142.5, { format: 'webp' });

// 4. Track concurrent workers
addUpDownCounter('workers.active', +1);
```

---

## 4. Cardinality Governance

High-cardinality metrics (e.g., tagging metrics with dynamic user IDs or timestamps) can destabilize time-series databases.

Pulse enforces strict attribute cardinality governance via `CardinalityGovernor` ([`src/utils/cardinality-governor.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/cardinality-governor.ts)):
- **Max Tag Keys:** Maximum 10 tag keys per metric name.
- **Max Unique Combinations:** Capped at 1,000 distinct tag value permutations per metric instrument.
- **Overflow Bucket:** When cardinality exceeds limits, excess tag combinations are collapsed into an `overflow: true` aggregate bucket, preserving overall numerical totals while protecting metric storage.
