# sdk-node Enterprise Audit Report

**Scope:** Implementation-only audit of the Pulse SDK Node.js client (`sdk-node/src`).  
**Source of truth:** Executable source code only. Documentation, comments, and design documents were ignored.  
**Objective:** Evaluate whether the SDK can support millions of applications, hundreds of thousands of organizations, and billions of events per day.

---

## Executive Summary

**Overall verdict:** The SDK has a reasonable foundation for a low-volume developer tool, but it is **not enterprise-ready** for hyperscale or mission-critical production systems. The audit uncovered multiple confirmed production risks: replay loops, pipeline bypasses, missing retries, main-thread compression, redirect credential leakage, and weak shutdown isolation.

**Key themes:**
- **Reliability:** Persistent events are re-replayed on every failed init retry, cron events bypass the full pipeline, and the transport has no retry/backoff/circuit breaker.
- **Performance:** Gzip compression runs on the main thread for every batch, errors are flushed immediately, and persistence compaction is O(N) per acknowledged batch.
- **Security:** Bearer tokens follow redirects, persisted files may be world-readable, and the security scrubber does not cover all event fields that carry user data.
- **Concurrency:** Transport updates can leave old batch-manager timers running, and the connection manager is a semaphore rather than a real pool.
- **Feature governance:** Entitlement gating is present, but several developer-facing helpers bypass killswitches and sampling.

**Recommendation:** Do not ship to enterprise customers without remediating the critical and high-priority findings. At minimum, fix the replay loop, enforce pipeline routing for all event types, add transport retry/backoff, move compression off the main thread, and harden secret handling.

---

## 1. Scalability Findings

| Finding | Location | Severity | Production Impact |
|---|---|---|---|
| Main-thread gzip compression on every outgoing batch | `src/transport/batch-manager.ts`, `src/transport/multiplexed-transport.ts`, `src/transport/http.ts` | **High** | Compression is CPU-bound and blocks the event loop. At 10k+ events/sec, serialization/compression becomes the dominant bottleneck. The `SerializationPool` exists but is not wired into the primary path. |
| Errors and crons flushed immediately | `src/transport/multiplexed-transport.ts` | **High** | Every error or cron event triggers an immediate HTTP request, defeating batching under load. In a high-error scenario this creates a self-amplifying request storm. |
| Persistence compaction is O(N) per batch acknowledgement | `src/storage/persistent-storage.ts` (discard path) | **High** | For each successful batch, the entire on-disk NDJSON file is read, parsed, filtered, and rewritten. This does not scale past a few thousand persisted events. |
| Per-event setImmediate pipeline scheduling | `src/core/event-pipeline.ts` | **Medium** | Scheduling every event via `setImmediate` yields fairness but adds latency and scheduling overhead at high throughput. |
| Label serialization sorts on every metric record | `src/metrics/registry.ts` | **Low** | Small label maps are sorted every call; acceptable for moderate cardinality but unnecessary overhead for high-cardinality workloads. |
| Connection manager is a semaphore, not a real pool | `src/transport/connection-manager.ts` | **Medium** | Limits concurrency but does not reuse TCP connections. High-throughput workloads pay the full TCP/TLS handshake cost on many requests. |

---

## 2. Performance Findings

| Finding | Location | Severity | Production Impact |
|---|---|---|---|
| Synchronous stack parsing + SHA-256 fingerprinting on every error capture | `src/capture/captureError.ts` | **Medium** | Although the fingerprint is cached, the initial capture is CPU-heavy and blocks the event loop. Stack parsing should be deferred. |
| JSON.stringify on large batches without worker offloading | `src/transport/http.ts`, `src/transport/multiplexed-transport.ts` | **High** | Large batches serialize and compress on the main thread, causing event-loop pauses and latency spikes. |
| Repeated string case conversions in command redaction | `src/instrumentation/auto-instrument.ts` (Redis hook) | **Low** | Redis command names are upper-cased on every statement serialization. Negligible overhead but avoidable. |
| Timer re-creation on every batcher flush | `src/transport/batch-manager.ts` | **Low** | Flush timers are recreated per batch; typical overhead but can be optimized with a single periodic timer. |

---

## 3. Memory Findings

| Finding | Location | Severity | Production Impact |
|---|---|---|---|
| Persistent buffer can grow until periodic flush | `src/storage/persistent-storage.ts` | **Medium** | Events are buffered in memory until debounced flush (1s). A crash in that window loses events; also transient memory growth. |
| Large discard rewrites allocate full file contents | `src/storage/persistent-storage.ts` | **High** | `readFile` loads the entire persistence file into memory. A 10MB file plus 10k events can spike heap significantly. |
| Label cache is bounded but entries are not weighted | `src/metrics/registry.ts` | **Low** | Cache eviction is FIFO; not a leak, but hot keys may be evicted. |
| Metric registry counts dropped events but does not cap | `src/metrics/registry.ts` | **Low** | Bounded by maxMetrics and cardinality governor, so generally safe. |

---

## 4. Concurrency & Race Condition Findings

| Finding | Location | Severity | Production Impact |
|---|---|---|---|
| Persisted events replayed on every init retry | `src/core/init.ts` | **Critical** | Replaying inside the `INIT_MAX_ATTEMPTS` loop means the same undelivered events are re-processed each time init fails. Causes duplicate sends, backend deduplication pressure, and potential memory spikes. |
| Transport update does not shut down old batch managers | `src/transport/transport-router.ts` | **High** | `updateTransport` clears maps without calling `shutdown` on existing `BatchManager` instances. Old flush timers and queues continue to run, leading to duplicate sends, stale config usage, and resource leaks. |
| Init is not fully single-flight across shutdown | `src/core/init.ts`, `src/core/lifecycle.ts` | **Medium** | Rapid init/shutdown cycles can overlap, creating races between replay and shutdown drain. |
| Shared mutable global state for instrumentation | `src/instrumentation/auto-instrument.ts` | **Medium** | Instrumentation guard and teardown registry are stored on `globalThis`. Correctly namespaced, but cross-SDK-version collisions remain possible if symbol names are reused. |
| Shutdown flush and write chain race | `src/storage/persistent-storage.ts` | **Low** | Shutdown marks initialized=false, then flushes, then awaits the write chain. New persists are blocked, so the sequence is safe. |

---

## 5. Security Findings

| Finding | Location | Severity | Production Impact |
|---|---|---|---|
| Bearer token forwarded on HTTP redirects | `src/transport/batch-manager.ts` | **High** | Fetch is configured with the Authorization header but no explicit redirect policy. If the backend ever issues a 3xx, the bearer token is leaked to the redirect target. |
| Default fetch follows redirects without restriction | `src/transport/http.ts`, `src/transport/batch-manager.ts` | **High** | Combined with the above, an attacker who can influence the backend/URL can exfiltrate telemetry payloads or auth tokens. |
| Persisted event files may be world-readable | `src/storage/persistent-storage.ts` | **High** | `mkdir` and file writes do not specify `mode`. On Unix-like systems the file inherits process umask, often making files readable by other users. Errors/PII may leak. |
| Security scrubber does not cover scope `extra` / `contexts` | `src/core/scope.ts`, `src/processors/security-scrubber.ts` | **High** | Values added via `setExtra` or `setContext` are stored after scrubbing, but when applied to events the scrubber does not recurse into `extra` / `contexts`. PII in those fields can reach the backend. |
| Source-map resolver reads local files before URL validation | `src/processors/source-map-resolver.ts` | **Medium** | File reads occur before the URL/SSRF guard, and application root defaults to `process.cwd()`. A crafted stack frame can read arbitrary files or SSRF. |
| Redis instrumentation over-redacts non-sensitive commands | `src/instrumentation/auto-instrument.ts` | **Low** | GET, SET, DEL, EXPIRE, HSET, HGET, HGETALL are treated as sensitive and redacted. This reduces telemetry utility and may hide legitimate operational data. |
| Event pipeline log preview may leak raw data | `src/transport/http.ts` | **Medium** | Failure logging scrubs previews, but the fallback path can return raw objects if scrubber fails. Verbose debug logging can expose headers and payloads. |

---

## 6. Reliability & Transport Findings

| Finding | Location | Severity | Production Impact |
|---|---|---|---|
| BatchManager has no retry, backoff, or circuit breaker | `src/transport/batch-manager.ts` | **High** | Failed batches are re-queued to the front but retried immediately on the next flush. No exponential backoff, jitter, or circuit breaker. Under backend pressure this creates a retry storm. |
| Remote transport retry configuration is unused | `src/transport/batch-manager.ts` | **High** | `SAFE_DEFAULTS_TRANSPORT.retry` defines maxRetries/backoff, but the batch manager does not read it. The only retry logic lives in the legacy `sendEvents` path. |
| Cron events bypass the full event pipeline | `src/subsystems/cron-subsystem.ts` | **Critical** | Cron check-ins call `transportRouter.send(event)` directly, skipping `processEvent`. This bypasses security scrubbing, deduplication, sampling/killswitch gates, rate limits, and feature-flag checks. |
| Metric convenience helpers bypass killswitch and sampling | `src/capture/captureMetric.ts` | **Critical** | `incrementCounter`, `setGauge`, `recordHistogram`, and `addUpDownCounter` only check `EntitlementGate.isAllowed('customMetrics')`. They ignore the `disableMetrics` killswitch and the sampling rate, allowing uncontrolled metric volume. |
| EventEmitter patch misses prependListener / prependOnceListener | `src/instrumentation/event-emitter-patch.ts` | **Medium** | Listeners added via `prependListener` are not bound to the active OTel context, causing context loss in applications that use that API. |
| captureLog severity 'log' may be silently dropped | `src/capture/captureLog.ts` | **Medium** | The severity mapper only converts `warn` → `warning`. It passes `'log'` through unchanged; if the backend schema expects a closed enum, these events may be rejected. |
| Graceful shutdown is best-effort | `src/core/lifecycle.ts` | **Medium** | Shutdown drains the pipeline, transport, and persistence, but individual subsystem timeouts can truncate flushing. In-flight HTTP requests are not explicitly awaited. |

---

## 7. Feature Verification

### Core APIs (always available)

These are gated only by the global SDK and project-level killswitches, not by billing entitlements:

- `captureError()`, `captureMessage()`
- `setUser()`, `setTag()`, `setContext()`
- `addBreadcrumb()`
- `flush()`, `shutdown()`

### Optional telemetry (no-op when disabled)

These are controlled by the entitlements block and become no-ops when revoked:

- `startSpan()`, `withSpan()`, `withSpanSync()` → controlled by `customSpans`
- `counter()`, `gauge()`, `histogram()` → controlled by `customMetrics`
- `captureLog()` → controlled by logging features/entitlements
- `captureProfile()` → controlled by `profiling`
- `captureReplay()` → controlled by `sessionReplay`

### Entitlements observed in code

Found in `src/core/entitlement-gate.ts` and `src/constants/defaults.ts`:

`customSpans`, `customMetrics`, `profiling`, `logging`, `sessionReplay`, `crons`, `requestCapture`, `tracing`, `errors`, `metrics`.

Safe defaults are fail-open (all `true`) until remote config explicitly disables them.

### Event types sent to backend

| Event Type | Route | Batch Size | Flush Interval |
|---|---|---|---|
| `error`, `message` | `/v1/errors` | 100 | 1,000 ms |
| `span`, `trace` | `/v1/traces` | 500 | 5,000 ms |
| `request` | `/v1/requests` | 500 | 5,000 ms |
| `metric` | `/v1/metrics` | 1,000 | 10,000 ms |
| `log` | `/v1/logs` | 200 | 10,000 ms |
| `profile` | `/v1/profiles` | 5 | 30,000 ms |
| `cron_checkin` | `/v1/checkins` | 1 | immediate |
| `replay` | `/v1/replays` | 5 | 10,000 ms |

---

## 8. Production Risks

- **Retry storm under backend pressure:** No backoff or circuit breaker means a 5xx/429 from the backend immediately triggers another request, amplifying load.
- **Duplicate telemetry on init failures:** The replay-inside-retry loop can replay the same events multiple times, increasing backend load and billable volume.
- **Cron check-ins silently bypass governance:** Crons are emitted directly to the transport, so they ignore sampling, killswitches, and PII scrubbing.
- **Token leakage on redirects:** A compromised or misconfigured ingest endpoint can redirect requests and receive the SDK bearer token.
- **Memory pressure on large persistence files:** Reading the entire NDJSON file into memory during discard can OOM containers with small heaps.
- **Context loss in EventEmitter:** Applications using `prependListener` will lose trace context, producing broken traces.
- **High CPU under load:** Main-thread compression and immediate error flushing make the SDK a CPU consumer rather than a background observer.
- **Stale transport after remote config updates:** Leftover timers from old batch managers can send events to outdated URLs or duplicate events.

---

## 9. Benchmark Predictions

| Workload | Predicted Behavior | First Bottleneck |
|---|---|---|
| 100 events/sec | Works; CPU usage modest. Compression latency visible but acceptable. | Per-event setImmediate scheduling |
| 1,000 events/sec | Main thread begins to show latency spikes during batch compression. Errors flushed immediately reduce effective batching. | Gzip serialization on main thread |
| 10,000 events/sec | Event-loop latency becomes unacceptable. CPU is dominated by compression and JSON.stringify. Request volume spikes due to immediate error flush. | Compression + immediate error flush |
| 100,000 events/sec | Not viable on a single Node process. Memory grows, queue overflows, and the application will starve. | Serialization/compression throughput |
| 1 million events/hour | ~278 events/sec average. Sustained load will keep CPU elevated; bursts above 1k/sec will cause backlog. | Compression and persistence compaction |
| Large traces (thousands of spans) | Traces exceed safe payload size; payload may be rejected or truncated. Batching 500 spans per batch helps but large traces still serialize as giant JSON. | Max payload size / JSON.stringify |
| Offline queue / frequent retries | Persistence grows; discard rewrites become O(N²) and dominate. No retry backoff means battery/disk churn. | Persistence discard path |

---

## 10. Bug Severity Matrix

### Critical Bugs

| ID | Bug | Location | Why It Blocks Enterprise Use |
|---|---|---|---|
| C1 | Persisted events replayed on every failed init retry | `src/core/init.ts` | Duplicates, backend load, potential feedback loop |
| C2 | Cron events bypass the full event pipeline | `src/subsystems/cron-subsystem.ts` | PII, governance, sampling, and killswitch bypass |
| C3 | Metric convenience helpers bypass killswitch and sampling | `src/capture/captureMetric.ts` | Uncontrolled metric volume and cost |

### High Priority Bugs

| ID | Bug | Location | Why It Matters |
|---|---|---|---|
| H1 | Main-thread gzip on every batch | `src/transport/batch-manager.ts`, `src/transport/multiplexed-transport.ts`, `src/transport/http.ts` | CPU/event-loop bottleneck at scale |
| H2 | No transport retry/backoff/circuit breaker | `src/transport/batch-manager.ts` | Retry storms and poor reliability |
| H3 | Bearer token forwarded on redirects | `src/transport/batch-manager.ts` | Auth token leakage |
| H4 | Transport update leaves old batch-manager timers running | `src/transport/transport-router.ts` | Resource leaks and duplicate sends |
| H5 | Security scrubber misses scope extra/contexts | `src/core/scope.ts`, `src/processors/security-scrubber.ts` | PII exposure |
| H6 | Persistence files may be world-readable | `src/storage/persistent-storage.ts` | Secret/PII leakage on disk |
| H7 | Immediate flush for errors and crons | `src/transport/multiplexed-transport.ts` | Request amplification and backend pressure |
| H8 | Persistence discard is O(N) full-file rewrite | `src/storage/persistent-storage.ts` | Memory and disk churn at scale |

### Medium Priority Bugs

| ID | Bug | Location | Why It Matters |
|---|---|---|---|
| M1 | Connection manager is a semaphore, not a pool | `src/transport/connection-manager.ts` | No connection reuse, higher latency |
| M2 | EventEmitter patch misses prependListener | `src/instrumentation/event-emitter-patch.ts` | Broken traces |
| M3 | captureLog severity 'log' not normalized | `src/capture/captureLog.ts` | Events may be dropped |
| M4 | Source-map resolver reads before URL guard | `src/processors/source-map-resolver.ts` | LFI/SSRF risk |
| M5 | Per-event setImmediate in pipeline | `src/core/event-pipeline.ts` | Latency/scheduling overhead |
| M6 | Synchronous stack parsing on every error | `src/capture/captureError.ts` | CPU spikes |

### Low Priority Bugs

| ID | Bug | Location | Why It Matters |
|---|---|---|---|
| L1 | Redis command list over-redacts | `src/instrumentation/auto-instrument.ts` | Reduced observability |
| L2 | Label serialization sorts every call | `src/metrics/registry.ts` | Minor overhead |
| L3 | Timer re-creation per flush | `src/transport/batch-manager.ts` | Minor overhead |

---

## 11. Recommended Improvements

| Priority | Recommendation | Expected Outcome |
|---|---|---|
| **Critical** | Move replay outside the init retry loop and dedupe by eventId before sending. | Eliminates duplicate replay and backend pressure. |
| **Critical** | Route all events, including crons, through the event pipeline. | Consistent scrubbing, sampling, killswitch, and governance. |
| **Critical** | Enforce killswitch and sampling in all metric capture helpers. | Prevents uncontrolled metric volume. |
| **High** | Move gzip/JSON serialization to a worker pool or off-thread pipeline. | Removes main-thread CPU bottleneck. |
| **High** | Implement retry with exponential backoff, jitter, and circuit breaker in BatchManager. | Improves reliability and prevents retry storms. |
| **High** | Set fetch redirect policy to `manual` or strip Authorization on cross-origin redirects. | Prevents token leakage. |
| **High** | Shutdown and dispose old batch managers in `TransportRouter.updateTransport`. | Eliminates resource leaks and stale sends. |
| **High** | Extend security scrubber to recurse into `extra` and `contexts` event fields. | Prevents PII leakage. |
| **High** | Set explicit file permissions (e.g., `0o600`) on persistence directory and files. | Prevents world-readable telemetry on disk. |
| **High** | Replace full-file discard with an append-only log plus periodic compaction, or use a WAL/SQLite store. | Scales persistence to millions of events. |
| **Medium** | Patch `prependListener` and `prependOnceListener` in EventEmitter instrumentation. | Complete context propagation. |
| **Medium** | Normalize `captureLog` severity values to a backend-compatible enum. | Prevents silently dropped logs. |
| **Medium** | Validate source-map URLs before file reads and sandbox app-root resolution. | Reduces LFI/SSRF surface. |
| **Low** | Cache sorted label serialization and avoid redundant case conversions. | Minor CPU savings. |

---

## 12. Stress-Test Recommendations

- **Million-event benchmark:** Measure throughput, CPU, and memory at 1M events over 15 minutes with all event types.
- **24-hour soak test:** Run continuous ingestion at 1k/sec and watch for memory growth, file growth, and timer leaks.
- **Retry storm test:** Return 429/5xx from a mock backend for 5 minutes and verify backoff and circuit breaker behavior.
- **Large persistence test:** Fill persistence to 10k/100k/1M events and measure replay and discard latency.
- **Network chaos test:** Inject latency, packet loss, and DNS failures; verify queue behavior and recovery.
- **Init-failure loop test:** Fail init 10 times in a row and confirm persisted events are only replayed once.
- **Redirect token leakage test:** Configure a backend that returns 302 and assert the SDK does not forward Authorization.
- **Shutdown stress test:** Rapidly init/shutdown 1000 times and verify no duplicate timers or resource leaks.

---

## 13. Final Scorecard

Scores are 1–10, where 10 is enterprise-grade and 1 is not production-viable.

| Category | Score | Rationale |
|---|---|---|
| Scalability | **4** | Main-thread compression, immediate flushes, and O(N) persistence block horizontal/vertical scale. |
| Performance | **4** | Serialization and compression dominate CPU; large batches cause event-loop pauses. |
| Memory Efficiency | **5** | Bounded caches and queues, but persistence discard loads full files into memory. |
| Concurrency Safety | **4** | Replay loop, stale batch managers, and shared global state create races. |
| Reliability | **4** | No transport retry/backoff, cron bypass, and best-effort shutdown reduce trust. |
| Fault Tolerance | **4** | Retry storms, no circuit breaker, and weak recovery from init failures. |
| Security | **4** | Token leakage, world-readable files, and scrubber gaps are serious. |
| Code Quality | **5** | Modular structure, but several incomplete implementations and hidden assumptions. |
| Maintainability | **5** | Decent separation, but debt from incomplete retry/pipeline wiring. |
| Developer Experience | **6** | Good defaults and clear API, but some features silently fail. |
| Production Readiness | **4** | Not ready for high-scale, long-running, or mission-critical workloads. |
| Enterprise Readiness | **4** | Multiple release-blocking issues for large-scale deployments. |
| Overall SDK Quality | **4** | Requires significant remediation before enterprise release. |

---

## 14. Overall Enterprise Readiness

**Not ready for enterprise deployment.** The SDK has a reasonable architecture and many correct safety defaults, but the confirmed critical bugs (replay loop, cron pipeline bypass, metric helper bypass) and the high-severity performance/security issues (main-thread compression, no retry, token leakage, PII scrubbing gaps) are release blockers for a large-scale SDK.

Remediating the critical/high findings would raise the score to **6–7**; adding worker-based compression, a real connection pool, and scalable persistence would be needed for an **8+**.

---

*Report generated from source-code analysis only. No SDK source code was modified.*
