# Performance Bugs / Findings — sdk-node

> **Status:** All findings in this document have been remediated. See [`FIXES.md`](./FIXES.md) for implementation details and verification.

This document lists performance defects and resource-usage risks found in the `sdk-node` transport and capture paths.

## P1 — Double `JSON.stringify` in `BatchManager`

- **File:** `src/transport/batch-manager.ts`
- **Evidence:**
  1. `nextSerializableBatch()` calls `byteLength(safeBatch)` which does `JSON.stringify({ events, route, timestamp })`.
  2. `sendBatch()` later calls `JSON.stringify({ events, route, timestamp })` again for the actual body.
- **Impact:** Every batch is serialized twice, doubling CPU cost on the hot path and increasing GC pressure under load. On a 500-event trace batch this is a measurable regression.
- **Fix:** Serialize once in `nextSerializableBatch()` and pass the pre-computed string/buffer through to `sendBatch()`. Update byte-length accounting to use the existing string.  
  **Status:** Fixed.

## P1 — `SerializationPool` Is Never Initialized

- **Files:** `src/transport/serialization-pool.ts`, `src/core/lifecycle.ts`
- **Evidence:** `SerializationPool.initialize()` has no call site in `init()` or `lifecycle.ts`. The worker-pool fallback is therefore dead code and every batch is compressed on the main thread.
- **Impact:** CPU-intensive gzip compression blocks the event loop; throughput drops and event-loop lag increases.
- **Fix:** Initialize `SerializationPool` during SDK init (when worker threads are available) and use it for batch compression in `BatchManager`. Keep a main-thread fallback for environments where `Worker` is unavailable.  
  **Status:** Fixed.

## P1 — Fingerprint SHA-256 Recomputed on Every Error Capture

- **File:** `src/processors/fingerprint.ts`
- **Evidence:** `generateFingerprint()` calls `sha256(parts.join('|'))` for every error, even identical errors.
- **Impact:** High-frequency repeated errors consume CPU for hashing; the same stack + message produces the same hash every time.
- **Fix:** Add an LRU cache keyed by the joined fingerprint parts. Cap cache size (e.g., 1,000 entries) and TTL to bound memory.  
  **Status:** Fixed.

## P2 — Metric Label Serialization Sorts Labels Every Record

- **File:** `src/metrics/registry.ts`
- **Evidence:** `serializeLabels()` is called inside every `recordHistogram()`, `incrementCounter()`, `addUpDownCounter()`, and `setGauge()` and sorts the label keys each time.
- **Impact:** Per-record `Object.keys().sort()` creates garbage and O(k log k) work for every metric sample.
- **Fix:** Cache the serialized label key by the sorted key string, or pre-compute a canonical label key in `cardinalityGovernor.sanitizeAttributes()`.  
  **Status:** Fixed.

## P2 — `flushIntervalMs` Is Hardcoded in `MultiplexedTransport`

- **File:** `src/transport/multiplexed-transport.ts`
- **Evidence:** `new MultiplexedTransport(baseUrl, apiKey)` uses default `flushIntervalMs = 2000`. The remote config value is ignored.
- **Impact:** Users cannot tune latency vs. throughput from the remote SDK; the multiplexed transport silently diverges from the per-route batch manager behavior.
- **Fix:** Pass `flushIntervalMs` from `TransportRemoteConfig` (or `TransportRouter` configuration) into `MultiplexedTransport`.  
  **Status:** Fixed.

## P2 — `maxMemoryMb` Is Advertised but Not Wired

- **Files:** `src/types/config.ts`, `src/utils/backpressure.ts`, `src/utils/adaptive-pressure.ts`
- **Evidence:** The config schema exposes `maxMemoryMb`, but `MemoryPressureMonitor` is constructed with hardcoded thresholds (`elevatedThreshold: 0.7`, `criticalThreshold: 0.9`) and does not use the limit.
- **Impact:** Users cannot set an explicit memory ceiling; the SDK only uses heap-utilization ratio, which is misleading on small containers or large heaps.
- **Fix:** Pass `maxMemoryMb` into `MemoryPressureMonitor` and `AdaptivePressureMonitor`; treat both ratio and absolute thresholds.  
  **Status:** Fixed.

## P2 — Remote Config Transport Knobs Are Ignored

- **File:** `src/transport/transport-router.ts`
- **Evidence:** `createConnectionManager()` uses hardcoded values: `maxTotalConnections: 100`, `connectionTimeoutMs: 5000`, `socketTimeoutMs: 30000`, `connectionTTLMs: 60000`, `idleConnectionTimeoutMs: 30000`. Remote config values for retry, keep-alive, and compression are not consumed.
- **Impact:** The remote SDK cannot tune connection limits, timeouts, or retry behavior. The hardcoded limits may overload or under-utilize the backend.
- **Fix:** Wire remote config transport settings into `ConnectionManager` and `BatchManager` (where not already wired) and remove dead config fields if unsupported.  
  **Status:** Fixed.

## P2 — `MultiplexedTransport` Serializes the Whole Payload at Once

- **File:** `src/transport/multiplexed-transport.ts`
- **Evidence:** `JSON.stringify(payload)` is called for the entire combined payload and then gzip-compressed. There is no per-route size limit; a single 10 MB payload can be produced.
- **Impact:** Large, latency-sensitive flush blocks the event loop; memory spikes; backend may reject oversized payloads.
- **Fix:** Bound the multiplexed payload size and split into multiple flushes, or route large routes through the standard `BatchManager` instead.  
  **Status:** Fixed.

## P2 — Cost Governor Not Updated from Remote Config

- **File:** `src/utils/cost-governor.ts`, `src/core/init.ts`
- **Evidence:** `costGovernor.updateFromConfig()` is only called with tracing defaults, not remote-config cost knobs.
- **Impact:** If the remote SDK wants to reduce telemetry under a budget, the local governor ignores the limit.
- **Fix:** Read cost/budget knobs from remote config and pass them to `costGovernor.updateFromConfig()`.  
  **Status:** Fixed.

## P3 — `RequestEvent` Body Captured as String Without Size Limit

- **File:** `src/instrumentation/request-capture-utils.ts`
- **Impact:** Large request bodies can be captured as a single string, increasing memory and payload size.
- **Fix:** Truncate captured bodies to a configurable maximum (default 10 kB) and record original size separately.  
  **Status:** Fixed.

## P3 — Deduplicator Fingerprint SHA-256 Every Event

- **File:** `src/processors/deduplicator.ts`
- **Impact:** Similar to `fingerprint.ts`; repeated events hash the same key repeatedly.
- **Fix:** Use a fast LRU cache in the deduplicator to skip hashing for recently seen keys.  
  **Status:** Fixed.
