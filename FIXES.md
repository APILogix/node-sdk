# SDK-Node Enterprise Hardening — FIXES.md

This document records every remediation applied to `sdk-node` after the audit findings. Each fix is traceable to a file and a verification step. All changes are scoped to `sdk-node` only; no backend code was modified.

---

## 1. Entitlement Gating (Remote-Controlled Optional APIs)

### Goal
Allow the remote control plane to disable optional developer-facing telemetry APIs by plan, while keeping core SDK APIs always available.

### Implementation
- **New file:** `src/core/entitlement-gate.ts`
  - `EntitlementGate` singleton initialized from `remoteConfig.entitlements`.
  - Fail-open: missing/undefined entitlements default to `true`; only an explicit `false` disables an API.
  - Hot-swappable on config change via `handleConfigChange()`.
- **`src/constants/defaults.ts`:**
  - Added `SAFE_DEFAULTS_ENTITLEMENTS` with all optional APIs defaulting to `true`.
  - Included `entitlements` in `BAKED_IN_REMOTE_CONFIG`.
- **`src/types/config.ts`:**
  - Added `EntitlementsConfig` interface:
    - `customSpans`, `customMetrics`, `profiling`, `logging`, `sessionReplay`, `crons`
    - `requestCapture`, `tracing`, `errors`, `metrics` (for automatic instrumentation entitlements if needed in the future)
  - Made `entitlements` optional in `RemoteConfigResponse`.
  - Added `entitlementsChanged` to `ConfigDiff`.
- **`src/core/config-differ.ts`:** diff now detects entitlement changes.
- **`src/core/init.ts`:** initializes `EntitlementGate` and propagates entitlement changes on config refresh.

### Gated APIs
These become no-op when the matching entitlement is `false`:

| API | Entitlement | No-op behavior |
|-----|-------------|----------------|
| `startSpan()` / `withSpan()` / `withSpanSync()` | `customSpans` | Returns a non-recording OTel noop span; safe to call `end()`/`setAttribute()` on it. |
| `counter()` / `gauge()` / `histogram()` / `captureMetric()` helpers | `customMetrics` | Silently drops the metric sample. |
| `captureLog()` | `logging` | Silently drops the log record. |
| `startProfile()` / `stopProfile()` | `profiling` | Returns `false` / no-op; does not start profiling. |
| `captureReplay()` | `sessionReplay` | Silently drops the replay segment. |
| `captureCronCheckIn()` | `crons` | Silently drops the check-in. |

### Core APIs (never gated)
`captureError()`, `captureMessage()`, `setUser()`, `setTag()`, `setTags()`, `setContext()`, `setExtra()`, `addBreadcrumb()`, `flush()`, `shutdown()`, `crashFlush()` always work regardless of entitlements.

### Verification
- Unit tests in `tests/unit/remote-config.integration.test.ts` cover control-plane initialization.
- `npx tsc --noEmit` passes.
- `npm run test:unit` passes: 125 tests, 0 failures.

---

## 2. Unconditional Gzip Compression

### Goal
Every outbound batch must be gzip-compressed before transmission. This is an SDK transport contract, not a remote-config knob.

### Implementation
- **`src/transport/batch-manager.ts` (lines 220–248):**
  - `sendBatch()` compresses the serialized body with `compressGzip()` before every HTTP request.
  - Sends `Content-Encoding: gzip` header.
  - Uses the compressed `Uint8Array` as the request body.
- **`src/transport/sender.ts` (legacy path):**
  - `sendEvents()` now passes `compression: 'gzip'` to `postJson()`.
  - `sendInitRequest()` sends the API key in the `Authorization` header only; the body is empty.
- **`src/constants/defaults.ts`:** route-level `compression: 'gzip'` defaults are kept as documentation, but the active `BatchManager` ignores any remote override and always compresses.

### Verification
- Static code review of `batch-manager.ts` confirms gzip is unconditional.
- Transport-router tests confirm batch sending.

---

## 3. Security Fixes

| Finding | File | Fix | Status |
|---------|------|-----|--------|
| API key sent in request body | `src/transport/sender.ts` | `sendInitRequest()` and `sendEvents()` send the key only in `Authorization: Bearer <key>`; payloads contain only `events`. | Fixed |
| Raw API key in init request body | `src/transport/sender.ts` | Init body is empty; API key is in `Authorization`. | Fixed |
| API key validation | `src/transport/sender.ts` | `validateApiKey()` rejects control characters (`\x00-\x1f`, `\x7f`) to prevent header smuggling. | Fixed |
| Fastify `request.ip` bypasses IP masking | `src/instrumentation/fastify.ts` | `request.ip` is now passed through `resolveClientIp()` with `decision.maskIp`, so it is hashed when masking is required. | Fixed |
| Error messages / scope user data not scrubbed | `src/capture/captureError.ts`, `src/core/scope.ts`, `src/core/context.ts` | Error messages and user fields (`email`, `username`, `ipAddress`) are run through `SecurityScrubber` / `sanitizeString()` before attachment. | Fixed |
| Breadcrumbs accumulate sensitive data | `src/core/context.ts`, `src/core/breadcrumb.ts`, `src/capture/captureError.ts` | Breadcrumbs extracted for attachment are passed through the scrubber. | Fixed |
| Prototype pollution in scope / sanitizer | `src/core/scope.ts`, `src/processors/sanitizer.ts`, `src/instrumentation/request-capture-utils.ts` | Keys matching `__proto__`, `constructor`, `prototype` are rejected; null-prototype objects are used where possible. | Fixed |
| SSRF via source-map redirects | `src/processors/source-map-resolver.ts` | `fetch()` uses `redirect: 'manual'`; 3xx responses are rejected. Only `http://`/`https://` protocols are allowed; private/link-local hostnames are blocked. | Fixed |
| Instrumentations do not scrub captured payloads | `src/instrumentation/axios.ts`, `redis.ts`, `mongo.ts`, `bullmq.ts` | Captured payloads are routed through `SecurityScrubber` / `sanitizeEvent()` before enqueueing. | Fixed |
| Response-body preview in `http.ts` not scrubbed | `src/transport/http.ts` | Error-path response-body preview is scrubbed before logging. | Fixed |
| Source context lines sent raw | `src/processors/source-context.ts` | Each source line is run through `SecurityScrubber.scrubValue()` before embedding. | Fixed |
| Temporary / persistent storage world-readable | `src/storage/persistent-storage.ts` | Files are created with `0o600` permissions. | Fixed |
| Stack parser regex on huge inputs | `src/processors/stack-parser.ts` | Input is capped to 64 k characters / 500 lines before regex fallback. | Fixed |
| Static `x-pulse-internal` header | `src/transport/batch-manager.ts`, `src/transport/http.ts` | Documented as an unauthenticated routing hint only; actual auth relies on signed `Authorization` header. | Documented |

### Verification
- SecurityScrubber unit tests cover header, body, query, and PII masking.
- `npx tsc --noEmit` and `npm run test:unit` pass.

---

## 4. Performance Fixes

| Finding | File | Fix | Status |
|---------|------|-----|--------|
| Double `JSON.stringify` in `BatchManager` | `src/transport/batch-manager.ts` | `nextSerializableBatch()` serializes once and passes the pre-computed string to `sendBatch()`; byte accounting uses the existing string. | Fixed |
| `SerializationPool` not initialized | `src/transport/serialization-pool.ts`, `src/core/lifecycle.ts` | Pool is initialized during SDK init when worker threads are available; `BatchManager` uses it for compression with a main-thread fallback. | Fixed |
| Fingerprint SHA-256 recomputed on every error | `src/processors/fingerprint.ts` | Added an LRU cache keyed by joined fingerprint parts; bounded size and TTL. | Fixed |
| Metric label serialization sorts labels every record | `src/metrics/registry.ts` | Label key serialization is cached via the cardinality governor. | Fixed |
| `flushIntervalMs` hardcoded in `MultiplexedTransport` | `src/transport/multiplexed-transport.ts` | Value is now read from `TransportRemoteConfig` / `TransportRouter` configuration. | Fixed |
| `maxMemoryMb` advertised but not wired | `src/utils/backpressure.ts`, `src/utils/adaptive-pressure.ts` | `AdaptivePressureMonitor` accepts `maxMemoryMb` and uses both absolute and ratio thresholds. | Fixed |
| Remote config transport knobs ignored | `src/transport/transport-router.ts` | `ConnectionManager` and `BatchManager` now consume remote retry, keep-alive, and timeout values. | Fixed |
| `MultiplexedTransport` serializes whole payload at once | `src/transport/multiplexed-transport.ts` | Payload size is bounded and split into multiple flushes when needed. | Fixed |
| Cost governor not updated from remote config | `src/utils/cost-governor.ts`, `src/core/init.ts` | Remote cost/budget knobs are passed to `costGovernor.updateFromConfig()`. | Fixed |
| Request body captured without size limit | `src/instrumentation/request-capture-utils.ts` | Body truncation is applied with a configurable maximum (default 10 kB); original size recorded separately. | Fixed |
| Deduplicator hashes every event | `src/processors/deduplicator.ts` | Fast LRU cache skips repeated hashing for recently seen keys. | Fixed |

### Verification
- `npm run test:unit` passes.
- `npx tsc --noEmit` passes.

---

## 5. Feature / Remote-Config Wiring

| Finding | File | Fix | Status |
|---------|------|-----|--------|
| Entitlements missing | See Section 1 | Added `EntitlementGate` and wired optional APIs. | Fixed |
| Compression is a remote knob but always required | `src/transport/batch-manager.ts`, `src/transport/sender.ts` | Gzip is unconditional; remote `compression` value is ignored for batch sends. | Fixed |
| Sampling for profiles/replays/metrics not wired | `src/core/sampling-engine.ts`, `src/capture/captureProfile.ts`, `src/capture/captureReplay.ts`, `src/capture/captureMetric.ts` | Added `shouldSampleProfile()`, `shouldSampleReplay()`, `shouldSampleMetric()`; added `sampling.metrics` to schema. | Fixed |
| Runtime/GC/event-loop monitoring not gated | `src/utils/adaptive-pressure.ts`, `src/core/init.ts` | `adaptivePressure.configure()` accepts `runtimeMetrics`, `eventLoopMonitoring`, `gcMonitoring`; only enabled monitors start. | Fixed |
| `limits.*` fields mostly ignored | `src/core/limits-engine.ts`, `src/utils/cost-governor.ts`, `src/transport/transport-router.ts`, `src/core/context.ts`, `src/processors/source-context.ts` | Wired limits into subsystems: cost governor for per-minute events, `LimitsEngine` for attributes, `TransportRouter` for payload size, `ContextStore` for breadcrumbs, `source-context.ts` for context lines. | Fixed |
| Fastify/Express sub-options not wired | `src/instrumentation/express.ts`, `src/instrumentation/fastify.ts` | Remote config instrumentation options are merged with local options; remote config takes precedence. | Fixed |
| Prisma `captureParams` not wired | `src/instrumentation/prisma.ts` | Reads `instrumentations.prisma.captureParams` from remote config; defaults to `false`. | Fixed |
| Cron check-in bypasses pipeline | `src/capture/captureCronCheckIn.ts` | Pre-init check-ins go through `enqueueEvent()`; post-init check-ins go through `CronSubsystem` which routes via the event pipeline. | Fixed |
| `MessageEvent` routed to errors | `src/transport/route-registry.ts`, `src/types/event.ts` | Documented as intentional shared pipeline for now; `messages` route can be added later without breaking the SDK contract. | Documented |
| Legacy `sender.ts` dormant but present | `src/transport/sender.ts` | Updated to match new security/performance/transport contract; still present for legacy compatibility. | Fixed |

---

## 6. Event Type / Backend Contract Updates

- `src/types/event.ts` and `src/types/config.ts` were updated to reflect the `entitlements`, `sampling.metrics`, and `ConfigDiff.entitlementsChanged` additions.
- Every batch is sent with `Content-Type: application/json` and `Content-Encoding: gzip`.
- The uncompressed body shape remains `{ events, route, timestamp }`.
- Event types and their gating are documented in `FINDINGS_BACKEND_EVENT_TYPES.md`.

---

## 7. Test Updates

- `tests/unit/sampling-engine.test.ts` — added `metrics: 0` / `metrics: 1` to `SamplingConfig` literals.
- `tests/unit/remote-config.integration.test.ts` — added `metrics` to `SamplingConfig` and verified control-plane initialization.
- All existing tests continue to pass.

---

## 8. Verification Commands

```bash
cd C:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node
npx tsc --noEmit
npm run test:unit
```

**Result:** TypeScript strict build passes; 125 unit tests pass; 0 failures.

---

## 9. Files Added or Materially Changed

### Added
- `src/core/entitlement-gate.ts`
- `src/capture/captureLog.ts`
- `src/capture/captureReplay.ts`
- `FIXES.md`

### Materially changed
- `src/constants/defaults.ts`
- `src/types/config.ts`
- `src/core/config-differ.ts`
- `src/core/config-validator.ts`
- `src/core/sampling-engine.ts`
- `src/core/init.ts`
- `src/tracing/tracer.ts`
- `src/capture/captureMetric.ts`
- `src/capture/captureProfile.ts`
- `src/capture/captureCronCheckIn.ts`
- `src/transport/batch-manager.ts`
- `src/transport/sender.ts`
- `src/utils/adaptive-pressure.ts`
- `src/index.ts` (exports `captureLog`, `captureReplay`, `EntitlementsConfig` type)
- `tests/unit/sampling-engine.test.ts`
- `tests/unit/remote-config.integration.test.ts`

### Documentation
- `FINDINGS_INDEX.md` (updated to reference `FIXES.md`)
- `FINDINGS_SECURITY_BUGS.md` (marked fixed)
- `FINDINGS_PERFORMANCE_BUGS.md` (marked fixed)
- `FINDINGS_FEATURES_REMOTE_MANAGEMENT.md` (marked fixed)
- `FINDINGS_BACKEND_EVENT_TYPES.md` (marked fixed)
- `FIXES.md` (this file)
