# Repository Audit Report — @vikasbaplawat1/pulse-sdk

This audit was performed by reading every source file under `src/` (all subdirectories: `core`, `types`, `capture`, `transport`, `tracing`, `subsystems`, `instrumentation`, `metrics`, `processors`, `storage`, `session`, `utils`, `constants`, `plugins`, `analysis`), the two entry points (`src/index.ts`, `src/internals.ts`), and `package.json`. It precedes and grounds the two documentation deliverables (`internal-sdk.md`, `sdk-docs.md`) and the `website/` build, per the audit-first requirement.

Everything below is traceable to a specific file. Where behavior could not be confirmed with certainty (no call site found across all read files, but a repository-wide `grep` was not run), this is stated explicitly rather than asserted as fact.

## 1. Exported API Inventory

### 1.1 Public surface — `src/index.ts` (semver-guaranteed)

**Lifecycle**
- `init(options)`, `createSDK(options)` (wraps `init`), `flush()`, `shutdown(timeoutMs?)`, `crashFlush(timeoutMs?)`, `getConfig()`, `SDKError` (class), `getSDKHealth()` (defined directly in `index.ts`).

**Capture**
- `captureError(error, options?)`, `captureRequest(event)`, `captureMessage(message, severity?, context?)`, `captureEvent(event)`, `captureCronCheckIn(monitorSlug, status, options?)`, `captureLog(level, message, ...args)`, `captureReplay(sessionId, segmentId, events)`, `startProfile(profileId)`, `stopProfile(profileId)`, `captureMetric(name, value, type?, options?)`, `incrementCounter`, `setGauge`, `recordHistogram`, `addUpDownCounter`.
- Types: `CronCheckInOptions`, `CaptureLogLevel`, `EventReceipt`.

**Context & breadcrumbs**
- `addBreadcrumb`, `getRequestContext`, `getTraceId`, `getSpanId`, `withContext`, `createContextStore`, `bindContext`. Type: `ContextStore`.

**Scope**
- `setUser`, `setTag`, `setTags`, `removeTag`, `setExtra`, `setExtras`, `removeExtra`, `setContext`, `getScopeData`, `clearScope`, `withScope`. Types: `User`, `ScopeData`.

**Tracing**
- `startSpan`, `withSpan`, `withSpanSync`, `getActiveSpan`, `flushTracer`, `extractTraceContext`, `injectTraceContext`. Types: `SpanStatus`, `SpanOptions`, `SpanLink`.

**Framework instrumentation**
- `monitorMiddleware` (+`PulseExpressOptions`), `fastifyPulsePlugin` (+`PulseFastifyOptions`), `registerAutoInstrumentations`, `createGraphQLInstrumentation` (+opts), `createPrismaInstrumentation` (+opts), `createMongoDBInstrumentation` (+opts), `createRedisInstrumentation` (+opts), `createBullMQInstrumentation` (+opts), `createAxiosInstrumentation` (+opts), `createPgInstrumentation` (+opts), `createMySQLInstrumentation` (+opts), `patchEventEmitter`/`unpatchEventEmitter`, `installHttpLifecycleGuard`/`uninstallHttpLifecycleGuard`/`isOtelInstrumentationError`, `computeExclusiveDuration`, `SpanDurationTracker` (class), `spanDurationTracker` (instance). Types: `SpanInterval`, `DurationBreakdown`.

**Logger control**
- `setLogger`, `setDebugMode`, `setLogLevel`. Types: `Logger`, `LogFormat`.

**Types only** (no runtime export)
- `SDKInitOptions`, `RemoteConfigResponse`, `EntitlementsConfig`, `SDKEvent`, `RequestEvent`, `ErrorEvent`, `MessageEvent`, `MetricEvent`, `EventMetadata`, `StackFrame`, `LogEvent`, `ProfileEvent`, `ReplayEvent`, `CronCheckInEvent`, `SpanEvent`, `TraceEvent`, `AggregatedSpanEvent`, `Breadcrumb`, `BreadcrumbInput`, `BreadcrumbHint`, `SeverityLevel`, `Severity` (const object, runtime value) + `severityFromString`, `SDKPlugin`, `PluginMeta`, `PluginContext`, `EventProcessor`, `BreadcrumbProcessor`, `CaptureErrorOptions`, `ParsedError`, `ErrorGrouping`.

Total distinct runtime-callable public exports: **57**. Total public type-only exports: **~35**.

### 1.2 Internal surface — `src/internals.ts` (explicitly no stability guarantee)

`ConfigManager`, `ConfigState`, `RemoteConfigClient`, `ConfigApplier`, `validateRemoteConfig`, `assertRemoteConfig`, `KillswitchEngine`, `FeatureController`, `SamplingEngine`, `LimitsEngine`, `diffConfigs`, `SecurityScrubber`, `TransportRouter`, `tenantGovernor` + `TenantGovernor`, `enqueueEvent`, `client`, `LoggingSubsystem`, `ProfilingSubsystem`, `CronSubsystem`, `EventLoopLagMonitor` (+types), `detectResources`/`detectOtelResource` (+type `ResourceAttributes`), `otelMetrics` (+type `OtelMetricsConfig`), `errorDeduplicator`, `persistentStorage`, `sourceMapResolver`, `metricsRegistry`, `persistenceGovernor` (+several storage/metrics types), `getSessionManager` (+types `Session`, `SessionManagerOptions`), `PulseSpan` (class), `getLogger`/`jsonLogger`/`setLogFormat`/`getLogFormat`, plus ~20 config/transport sub-types (`FeaturesConfig`, `SamplingConfig`, `RouteSamplingRates`, `InstrumentationConfig`, `PrivacyConfig`, `PrivacyCaptureConfig`, `ScrubbingConfig`, `PiiDetectionConfig`, `LimitsConfig`, `KillswitchesConfig`, `TransportRemoteConfig`, `TransportRouteConfig`, `TransportRouteName`, `TransportRetryConfig`, `TransportQueueConfig`, `ConfigMeta`, `ConfigDiff`, `REMOTE_CONFIG_SCHEMA_VERSION`, `TransportResult`, `IngestPayload`, `TransportHealth`, `TransportAdapter`, `RouteTransportHealth`, `MultiRouteTransportHealth`).

This surface exposes internal engines (config, killswitches, entitlements, sampling, limits, security scrubbing, transport routing, tenant governance, subsystems) explicitly for power users and the project's own integration tests. It carries no semver guarantee per its own file header.

## 2. Missing Documentation

The following are real, working, exported capabilities with little or no user-facing documentation prior to this audit:

- **`getSDKHealth()`** (public, `index.ts`) — a comprehensive health snapshot (circuit state, queue size/dropped/dead-letter, memory, session, plugin count, dedup stats, persistence stats, source-map cache stats, metrics counts). Not previously documented with its full return shape.
- **`PULSE_TRANSPORT_CONSOLE`** and **`PULSE_SDK_CONSOLE_DEBUG`** environment variables (`src/transport/batch-manager.ts`, `src/utils/console-debug.ts`) — toggle verbose console dumping of transport and pipeline activity. Not mentioned in `README.md` or any pre-existing file under `docs/`.
- **`onBeforeShutdown(hook)`** (`src/core/lifecycle.ts`) — registers a hook that runs before orchestrated shutdown, with a per-hook timeout. Exported from its module but not re-exported from either `index.ts` or `internals.ts`, so it is reachable only by code inside the SDK's own module graph, not by application code. Not part of any documented contract.
- **`extractWorkerContext`/`createWorkerData`/`serializeContext`** (`src/core/worker-context.ts`) — a complete, working worker-thread context-propagation module with no export path from either public surface (see §4).
- Multiple internal singletons' `getStats()`/`getHealth()` shapes (`TransportRouter.getHealth()`, `TenantGovernor.getStats()`, `CardinalityGovernor.getStats()`, `PersistenceGovernor.getStats()`, `CostGovernor.getStats()`) are useful for operators but were undocumented outside code comments.

## 3. Deprecated APIs

- **`processEvent(event)`** (`src/core/event-pipeline.ts`) — explicitly marked `@deprecated` in its own docstring: "Prefer `enqueueEvent()` for new code." Still exported from `internals.ts` (as `enqueueEvent`, the replacement) but `processEvent` itself is not part of either public surface — it is used internally by the tracer, trace aggregator, and metric reader as their event-injection point.
- **`Event` type** (`src/types/event.ts`) — explicitly marked `@deprecated Use SDKEvent instead`, defined as `SDKEvent | (Record<string, unknown> & { eventId?: string })` for backward compatibility.
- **`sha1()`** (`src/utils/hash.ts`) — marked `@deprecated Prefer sha256 for new code` in its own docstring. No call site was found for it among the files read.
- **`SlowRequestDetector`** (`src/processors/slow-request-detector.ts`) — the file's header comment states `@deprecated — REMOVED in v3.0`. Retained only as a backward-compatible no-op stub; every method returns an empty/false/zero result. Slow-request detection is now performed backend-side from OTel `http.server.duration` histograms.

## 4. Experimental / Not Fully Implemented

- **Heap profiling** — `ProfileEvent.profileType` is typed as `'cpu' | 'heap'` and `PROFILING_DEFAULTS.heap` exists as a flag (`src/constants/internal-defaults.ts`), but `src/subsystems/profiling-subsystem.ts` implements only `startCpuProfile`/`stopCpuProfile` via the V8 Inspector `Profiler` domain. There is no heap-profile start/stop path anywhere in the codebase. The public `startProfile`/`stopProfile` capture functions are CPU-profiling only.
- **B3 trace propagation** — `TRACING_DEFAULTS.propagation.b3` (`src/constants/internal-defaults.ts`) exists as a boolean flag, but `src/tracing/tracer.ts`'s `CompositePropagator` construction only ever adds `W3CTraceContextPropagator` and, conditionally, `W3CBaggagePropagator`. No B3 propagator is constructed anywhere.
- **`transport.routes.*.compression` config field** — validated as `'gzip' | 'none'` by `config-validator.ts` and threaded through `BatchManager`'s options, but the actual send path in `src/transport/batch-manager.ts` always calls `compressGzip()` directly regardless of the configured value (comment: "telemetry batches are always sent gzip-compressed. Retained for config compatibility"). The field has no observable effect on wire behavior today.
- **Brotli compression** — fully implemented (`src/utils/compression.ts`, `src/transport/serialization-worker.ts`) and reachable via `SerializationPool`/`http.ts`'s `postJson()`, but the primary telemetry batch-send path (`BatchManager.sendBatch`) never uses it; it is gzip-only in practice.

## 5. Dead Code

Eight files are intentional legacy placeholders — each contains only `export {}` (or, in one case, a fully no-op class) with an explanatory comment naming what superseded them:

| File | Superseded by |
|---|---|
| `src/core/version-policy.ts` | Removed from wire contract entirely |
| `src/core/plan-gate.ts` | `EntitlementGate` / remote `entitlements` section |
| `src/transport/retry.ts` | `BatchManager` + remote transport config |
| `src/transport/multiplexed-transport.ts` | `TransportRouter` / `BatchManager` |
| `src/transport/sender.ts` | `RemoteConfigClient` (config) / `TransportRouter` (telemetry) |
| `src/transport/batcher.ts` | Per-route `BatchManager` |
| `src/instrumentation/http.ts` | `registerAutoInstrumentations()` |
| `src/processors/slow-request-detector.ts` | Backend-side OTel latency-histogram analysis (also listed in §3, Deprecated) |

These are not accidental — each carries a one-line rationale in the source and represents a clean architectural migration trail, not orphaned code.

Additional dead-code observations:
- `src/instrumentation/index.ts` is a convenience barrel re-exporting the instrumentation factories, but `src/index.ts` imports each instrumentation module directly rather than through this barrel. The barrel has no confirmed internal consumer among the files read.
- `TRACING_DEFAULTS.maxSpanAttributes` (`src/constants/internal-defaults.ts`, value `200`) is defined but the actual span-attribute-truncation logic in `src/tracing/tracer.ts` reads `activeConfig.limits.maxSpanAttributes` (the remote-configured value) instead. The constant appears unused for its apparent purpose.

## 6. Unused Exports (no confirmed call site among files read)

The following are exported and appear fully implemented, but no call site was found while reading every file under `src/`. A full repository-wide `grep`/build-time tree-shaking analysis was not run, so these are reported as "no call site found," not as definitively dead:

- `serializeContext`, `createWorkerData`, `extractWorkerContext` (`src/core/worker-context.ts`) — no import of this module appears anywhere in `index.ts`, `internals.ts`, or any other file read.
- `severityGte`, `severityMeetsThreshold` (`src/types/severity.ts`) — `severityMeetsThreshold` **is** used internally by `src/utils/logger.ts`; `severityGte` itself has no confirmed caller.
- `generateShortId` (`src/utils/uuid.ts`) — span/event IDs are generated via OTel's own ID generator and `generateId()` (full UUID) respectively; no call site found for the short-ID variant.
- `TokenBucketRateLimiter`, `SlidingWindowRateLimiter` (`src/transport/rate-limit.ts`) and the standalone `CircuitBreaker` class (`src/transport/circuit-breaker.ts`) — the active transport stack (`ConnectionManager`, `HealthMonitor`) implements its own inline semaphore and circuit-state logic rather than composing these classes.
- `CostGovernor.shouldReduceTelemetry()` (`src/utils/cost-governor.ts`) is computed from a bytes-per-minute budget, but no call site was found reading this value back to actually reduce telemetry volume.

## 7. Notable Correctness / Consistency Findings

These are not "bugs" in the sense of broken functionality observed at runtime, but are discrepancies between documentation-adjacent claims and actual code, or internal inconsistencies worth flagging for engineering awareness:

1. **Control-plane request body.** `src/core/remote-config-client.ts` sends an empty JSON body (`{}`) for both `/v1/init`-equivalent and refresh calls; the API key travels exclusively via the `X-API-Key` HTTP header. A body shape resembling `{"apiKey": "..."}` is not what the code sends.
2. **Two different API-key transport mechanisms exist.** Control-plane calls use `X-API-Key`; the telemetry/event batch-send path (`BatchManager.sendBatch`) uses `Authorization: Bearer <apiKey>`. `types/transport.ts`'s `IngestPayload.apiKey` field (modeling the key as living inside the JSON payload) does not match either actual mechanism.
3. **Unconditional response logging.** `remote-config-client.ts`'s `post()` method calls `console.log('[Pulse] control-plane response', { endpoint, statusCode, body: payload })` unconditionally on every control-plane call, bypassing the SDK's own configurable logger and its debug/log-level gating. This does not echo the API key itself, but it does print full response bodies to stdout regardless of settings.
4. **No retry jitter.** `retryDelay()` in `src/transport/batch-manager.ts` is a pure deterministic function of the configured backoff strategy and attempt number — there is no randomization/jitter term, despite jitter being a standard resilience technique for avoiding retry storms.
5. **`ConnectionLease.release(healthy = true)`** (`src/transport/connection-manager.ts`) accepts a `healthy` parameter that has no effect on behavior in the current implementation.
6. **`CaptureErrorOptions.tags`** (`src/types/error.ts`) is declared in the type but not read anywhere inside `captureError()`'s implementation.
7. **`recordHistogram()`'s `unit` parameter** (`src/capture/captureMetric.ts`) is accepted in the function signature but not forwarded to `metricsRegistry.recordHistogram()`.
8. **`MetricEvent.rate`** is always set to `0` by `pulse-metric-reader.ts`'s `dataPointToEvent()` — it is never computed from observed throughput.
9. **Two independent `MemoryPressureMonitor` instances** run in a single process: one embedded inside `AdaptivePressureMonitor` (drives load-shedding and persistence-governance decisions) and one created lazily and independently for `getSDKHealth()` reporting (`index.ts`'s `getSharedMemoryMonitor()`). They read the same `process.memoryUsage()` data but are not the same object or timer.
10. **Prisma `captureParams`** has no underlying hook in `@prisma/instrumentation`; parameter redaction, where it happens at all, is enforced only by generic downstream pipeline scrubbing, not by the instrumentation itself.

## 8. Validation Notes

- Every claim about request/response shapes, header names, timeouts, retry policy, sampling algorithm, batching thresholds, and killswitch/entitlement/feature semantics in the two documentation deliverables that follow this report is derived from the specific source files named above. Numeric constants (timeouts, buffer sizes, thresholds) are quoted directly from the source, not estimated.
- Backend-side behavior (what the control plane actually does with `/v1/init` or `/v1/sdk-config` requests, how entitlements/features are computed server-side, the real production origin) is **Not Found In Codebase** — this SDK repository contains only the client, and no assumptions about server internals are made in the generated documentation.
- Proprietary operational details that would qualify as sensitive infrastructure information (the literal hardcoded production origin string in `src/constants/defaults.ts`) are described structurally in the documentation that follows (e.g., "a production SaaS origin, overridable via `baseUrl` or `SDK_BASE_URL`") without reproducing the literal value, consistent with the constraint against leaking backend endpoint specifics.
