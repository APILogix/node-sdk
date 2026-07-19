# Feature / Remote-Config Management Findings — sdk-node

> **Status:** All findings in this document have been remediated. See [`FIXES.md`](./FIXES.md) for implementation details and verification.

This document lists features that are either not remotely manageable, partially wired, or inconsistent with the remote config schema.

## P0 — Entitlements for Optional Telemetry Missing

- **Files:** `src/types/config.ts`, `src/core/entitlement-gate.ts` (added), `src/tracing/tracer.ts`, `src/capture/captureMetric.ts`, `src/capture/captureLog.ts`, `src/capture/captureProfile.ts`, `src/capture/captureReplay.ts`, `src/capture/captureCronCheckIn.ts`
- **Evidence:** The remote config schema previously had no `entitlements` block. Developer APIs such as `startSpan()`, `counter()`, `gauge()`, `histogram()`, `captureLog()`, `captureProfile()`, `captureReplay()`, and cron check-ins were always active, regardless of the customer's plan.
- **Impact:** Free-tier or disabled customers can consume paid features without enforcement; the SDK does not honor backend entitlements.
- **Fix:** Add `entitlements: { customSpans, customMetrics, profiling, sessionReplay, crons, logging }` to the remote config schema, create `EntitlementGate`, and make the optional APIs return no-op implementations when disabled. Core APIs (`captureError`, `captureMessage`, `setUser`, `setTag`, `setContext`, `addBreadcrumb`, `flush`, `shutdown`) remain always available.  
  **Status:** Fixed.

## P1 — Compression Is a Remote Config Knob but Always-On Gzip Is Required

- **Files:** `src/types/config.ts`, `src/transport/batch-manager.ts`, `src/transport/multiplexed-transport.ts`, `src/transport/sender.ts`
- **Evidence:** The remote config schema contains a `compression` field, but the product requirement is that every batch must be gzip-compressed regardless of remote config.
- **Impact:** If remote config disabled compression, the backend would reject uncompressed payloads. If the SDK honored the knob, the contract breaks.
- **Fix:** Ignore remote config compression for batch sends; always gzip with `Content-Encoding: gzip`. Document this as a non-configurable SDK transport contract.  
  **Status:** Fixed.

## P1 — Sampling Rates for Profiles, Replays, and Metrics Not Wired

- **Files:** `src/types/config.ts`, `src/core/sampling-engine.ts`, `src/capture/captureProfile.ts`, `src/capture/captureReplay.ts`, `src/capture/captureMetric.ts`
- **Evidence:** The remote config schema exposes `sampling.profiles` and `sampling.replays`. `SamplingEngine` has `shouldSampleError()` and `shouldSampleTrace()` but no methods for profiles, replays, or metrics. The capture APIs do not query a sampling decision.
- **Impact:** Remote config cannot control profile/replay/metric volume; these features run at 100% or use an unrelated default.
- **Fix:** Add `shouldSampleProfile()`, `shouldSampleReplay()`, and `shouldSampleMetric()` to `SamplingEngine`; add `sampling.metrics` to the schema; call these methods in the capture APIs.  
  **Status:** Fixed.

## P1 — Runtime/GC/Event-Loop Monitoring Not Gated by Remote Config

- **Files:** `src/utils/adaptive-pressure.ts`, `src/core/init.ts`
- **Evidence:** The remote config advertises `runtimeMetrics`, `eventLoopMonitoring`, `gcMonitoring`. The `AdaptivePressureMonitor` starts all three unconditionally.
- **Impact:** Customers cannot disable monitoring overhead from the remote SDK; disabled features still consume CPU and memory.
- **Fix:** Read `runtimeMetrics`, `eventLoopMonitoring`, `gcMonitoring` from remote config and start only the enabled monitors.  
  **Status:** Fixed.

## P2 — `limits.*` Fields Mostly Ignored

- **Files:** `src/types/config.ts`, `src/core/limits-engine.ts`
- **Evidence:** `limits` includes `maxEventsPerMinute`, `maxSpansPerTrace`, `maxAttributesPerEvent`, `maxAttributeValueLength`, `maxBreadcrumbs`, `maxContextLines`, `maxPayloadBytes`, `maxAttachmentSize`. Only attribute limits are actively enforced; the rest are either unused or enforced by hardcoded constants elsewhere.
- **Impact:** Remote config cannot tune back-pressure, payload size, or breadcrumb limits.
- **Fix:** Wire each limit into the relevant subsystem: `costGovernor` for per-minute events, `LimitsEngine` for attributes, `TransportRouter` for payload size, `ContextStore` for breadcrumbs, and `source-context.ts` for context lines.  
  **Status:** Fixed.

## P2 — Fastify/Express Instrumentation Sub-Options Not Wired

- **Files:** `src/instrumentation/express.ts`, `src/instrumentation/fastify.ts`, `src/types/config.ts`
- **Evidence:** The remote config schema has nested `instrumentations.express` / `instrumentations.fastify` blocks with `captureHeaders`, `captureQuery`, `captureBody`, `sampleRate`, `ignorePaths`. The middleware reads only local options, not remote config.
- **Impact:** Remote config cannot toggle request capture or redaction; behavior is determined solely by local code.
- **Fix:** Merge remote config instrumentation options with local options in the middleware/plugin factories, with remote config taking precedence (or explicit local override).  
  **Status:** Fixed.

## P2 — Prisma `captureParams` Not Wired

- **Files:** `src/instrumentation/prisma.ts`, `src/types/config.ts`
- **Evidence:** The remote config schema advertises `instrumentations.prisma.captureParams`, but the instrumentation uses a hardcoded default.
- **Impact:** Customers cannot disable Prisma query-parameter capture from the remote SDK, risking PII leakage.
- **Fix:** Read `instrumentations.prisma.captureParams` from remote config and default to `false` if not set.  
  **Status:** Fixed.

## P2 — Cron Check-In Bypasses Normal Pipeline

- **File:** `src/capture/captureCronCheckIn.ts`
- **Evidence:** Cron check-ins are sent directly to the transport queue after the initial feature check, bypassing the event pipeline, sampling, and scrubbing.
- **Impact:** Cron payloads may contain unscrubbed data and ignore sampling decisions.
- **Fix:** Route cron check-ins through `captureEvent()` / `processEvent()` like other event types, then apply sampling and scrubbing.  
  **Status:** Fixed.

## P2 — `MessageEvent` Routed to `errors` Instead of a Dedicated Route

- **File:** `src/transport/route-registry.ts`, `src/types/event.ts`
- **Evidence:** The `message` event type is emitted by `captureMessage()` but is routed to the `errors` ingest endpoint because no dedicated route exists.
- **Impact:** Backend ingestion logic for messages is mixed with error events; semantic separation is lost.
- **Fix:** Add a `messages` route to `route-registry.ts` and route `message` events there, or document that messages intentionally share the errors pipeline.  
  **Status:** Documented as intentional shared pipeline.

## P3 — Legacy `sender.ts` Path Is Dormant but Still Present

- **File:** `src/transport/sender.ts`
- **Evidence:** The new `TransportRouter` / `BatchManager` path is active, but `sendEvents()` and `sendInitRequest()` remain exported and contain outdated security/performance patterns (API key in body, no scrubbing, no gzip always-on).
- **Impact:** Dead code is a maintenance and security liability; any future caller reintroduces the bugs.
- **Fix:** Mark `sendEvents()` as deprecated and remove the body-key behavior, or remove it entirely if unused.  
  **Status:** Fixed — updated to the new security/performance/transport contract; kept for legacy compatibility.
