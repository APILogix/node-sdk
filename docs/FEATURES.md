# Features and gates

This matrix describes code paths present in the SDK and the controls that can make them inactive. “Supported” means implemented, not that every backend plan or remote configuration enables it.

## Gate model

Three independent remote-control layers exist:

1. `features.*` controls subsystem construction and event-family admission. Turning a feature off prevents or tears down the corresponding subsystem.
2. `killswitches.*` is an operational stop mechanism for the SDK, tracing, metrics, transport, profiling, errors, or logs.
3. `entitlements.*` is a complete backend-owned gate for developer-facing optional APIs. Before initialization only, static checks allow bootstrap buffering; after a snapshot is installed, every explicit boolean is authoritative and `false` makes the affected API a no-op rather than throwing.

Sampling and tenant governance are additional admission controls. Queue pressure, payload limits, rate limits, load shedding, and transport availability can still drop an otherwise enabled event.


## Core capture and context

| Capability | Supported behavior | Relevant gates / no-op behavior |
|---|---|---|
| Error capture | Stack parsing, fingerprinting, breadcrumb/context/trace correlation, active-span error recording, source context, deduplication | Error killswitch, `features.errors`, error sampling, limits/pressure. Not billing-entitlement gated. |
| Message capture | Severity, context, breadcrumbs, trace/span correlation | Messages remain core and have no dedicated feature/entitlement; global SDK, limits, pressure, queue, processor, and transport gates still apply. |
| Request capture | Complete `RequestEvent`, active trace correlation, framework middleware | `features.requestCapture`, tracing killswitch, request sampling, tenant admission, and backend instrumentation/privacy policy. |
| Universal capture | `captureEvent()` accepts the ten `SDKEvent` variants and returns an acceptance/processing receipt | Unknown event types have no route. Any canonical pipeline gate may reject. |
| Scope | User, tags, extras, named contexts, isolated `withScope()` clones | Local in-process behavior; enrichment can still be removed by a later processor. Dangerous object keys are rejected. |
| Request context | Request/session/user/tenant data, breadcrumbs, async propagation and callback binding | `addBreadcrumb()` is a no-op without a `ContextStore`. Context does not itself force telemetry capture. |
| Lifecycle | Flush, structured graceful shutdown, bounded crash flush, signal handlers | Best-effort and time-bounded; no delivery guarantee. |

## Optional telemetry APIs

| API family | Supported behavior | Explicit no-op gate |
|---|---|---|
| Custom spans | `startSpan`, async `withSpan`, sync `withSpanSync`, attributes, events, links, error/status, timeout, active span access | `entitlements.customSpans === false` returns a non-recording span. No tracer also returns a safe no-op span. Tracing feature/killswitch controls exporting. |
| Custom metrics | Counter, gauge, histogram, up-down counter, deterministic admission, registry aggregation/cardinality controls | `entitlements.customMetrics === false`, metrics killswitch, or metric sampling drop. |
| Structured logs | Explicit logs, console interception when configured, level normalization, args, trace correlation | `entitlements.logging === false`, absent logging subsystem, `features.logging === false`, or logs killswitch. |
| CPU profiles | Manual start/stop and trace-root profile integration | `entitlements.profiling === false`; `startProfile()` returns `false`. Also no-op when not initialized, subsystem absent, sampled out, feature off, or profiling killed. |
| Replay segments | Caller-supplied segments, session-level deterministic sampling, privacy scrub | `entitlements.sessionReplay === false`, empty ID/events, replay sampling, or `features.sessionReplay === false`. This is not browser DOM recording. |
| Cron check-ins | In-progress/ok/error, duration/environment, five-minute timeout tracking after init | `entitlements.crons === false`, `features.crons === false`, or absent subsystem. Pre-init calls can buffer but do not start timeout tracking. |

Entitlements `requestCapture`, `tracing`, `errors`, and `metrics` are part of the complete wire schema for automatic telemetry policy, but core error/message APIs intentionally do not consult the billing gate. `FeatureController`, killswitches, sampling, and backend instrumentation configuration remain authoritative in their respective paths.

## Tracing

Supported:

- OpenTelemetry `NodeTracerProvider` when the SDK can safely own it.
- Reuse of an existing global provider/context setup rather than replacement.
- Parent-based deterministic root sampling and active-context propagation.
- W3C Trace Context and baggage according to SDK internal defaults.
- Manual spans, async/sync active spans, attributes, events, errors, links, and deadlines.
- Automatic span capture for enabled HTTP/framework/database/queue integrations.
- Pulse `span` events and aggregated `trace` documents, including partial traces.
- Exclusive-duration calculation from child intervals.
- Request, session, user, and tenant correlation.

Not supported or not guaranteed:

- No OTLP exporter. The custom exporter converts spans to Pulse events.
- No promise that the SDK can replace or configure a provider already installed by another library.
- `startSpan()` is not active; use `withSpan()` for automatic child parenting.
- A span timeout ends telemetry only; it does not cancel user work.
- Sampling can omit non-error spans; route/feature/limits controls can drop exports.

## Metrics

The metrics registry supports counter, gauge, histogram, and up-down counter recording. Histograms use the SDK's OpenTelemetry metrics implementation for aggregation and percentiles, while transport emits Pulse `metric` events. Runtime metrics, event-loop monitoring, and GC monitoring are independent remote feature flags used by adaptive pressure monitoring.

Metric series remain subject to configured histogram buckets, percentiles, cardinality limits, sampling, limits, and memory/event-loop/GC/queue pressure. The API is not a general OTLP metrics exporter.

## Logging

The logging subsystem supports explicit `captureLog()` and configured console interception. Public aliases normalize `warn` to `warning` and `log` to `info`. Args are bounded and scrubbed, and logs correlate with request/trace/span context. A `message` event is separate from a `log` event: messages use the `events` route and are core; logs use the `logs` route and are entitlement/feature controlled.

## Profiling

Manual profiling captures CPU profiles only. `ProfileEvent` also permits the wire discriminator `profileType: 'heap'`, but the public `startProfile`/`stopProfile` path invokes CPU profiling; this document does not claim a public manual heap-profile API. Profiling can also follow root trace lifecycle when enabled.

## Session and replay

The SDK tracks process sessions for crash-free/session correlation and exposes replay-segment submission. Replay payload entries are opaque caller data after scrubbing. Session replay entitlement/feature names do not imply that a Node process records browser interactions itself.

## Cron monitoring

Cron check-ins route through the same canonical event pipeline as other events. Post-init in-progress monitors retain a timer; an absent completion produces an error check-in after the internal five-minute timeout. The example backend policy configures cron batch size one and zero wait; deployments may change those explicit route fields.

## Framework support

### Express and Fastify

Both integrations support:

- prefix/regex ignored paths and ignored methods;
- deterministic request sampling and tenant admission;
- request ID from `x-request-id`/`x-correlation-id` or generation;
- tenant/session/user/client correlation;
- backend-authoritative header/query/body/response capture;
- response status, latency, body/response size;
- trusted-proxy-aware client IP handling;
- request-local context and breadcrumbs;
- error capture.

Express handles response finish/close/error and `next(error)`. Fastify installs request, pre-handler, response, and error hooks. Neither integration guarantees that arbitrary unparsed body streams are retained.

### Auto-instrumentation

The public `registerAutoInstrumentations()` function takes no policy options. HTTP, HTTPS, Express, Fastify, Undici/fetch, GraphQL, Prisma, MongoDB, Redis, BullMQ, Axios, PostgreSQL, MySQL2, and EventEmitter context binding are selected from the active complete backend snapshot when registration occurs. Registration is guarded globally and reset on shutdown; no baked instrumentation policy is merged.

### Optional integration caveats

- Axios adds Axios-specific spans and may overlap with underlying Node HTTP spans.
- Prisma standalone factory options are broader than what its wrapper directly applies; auto-registration performs engine-span filtering.
- SQL/query, Redis command, MongoDB statement, job data, headers, body, and response detail are privacy-sensitive and default to constrained capture.
- Optional library availability and load order affect whether patching succeeds.
- EventEmitter patching includes `on`, `addListener`, `once`, `prependListener`, and `prependOnceListener`, and is unwound during reset.

## Remote feature switches

`features` includes:

| Feature | Effect when false |
|---|---|
| `tracing` | Tracer/auto-instrumentation subsystem is not started or is torn down; span events are rejected. |
| `requestCapture` | Request events are rejected; framework gate skips capture. |
| `errors` | Global error handlers are not installed/are removed; error events are rejected. |
| `metrics` | Meter provider is not started/tears down; metric events are rejected. |
| `logging` | Logging subsystem is not started/tears down; log events are rejected. |
| `profiling` | Profiling subsystem is not started/tears down; profile events are rejected. |
| `crons` | Cron subsystem is not started/tears down; check-ins are rejected. |
| `sessionReplay` | Session/replay subsystem is not started; replay events are rejected. |
| `runtimeMetrics` | Adaptive runtime metrics signal collection is disabled. |
| `eventLoopMonitoring` | Event-loop pressure signal is disabled. |
| `gcMonitoring` | GC pressure signal is disabled. |

Feature transitions are hot-applied. Factories and teardowns are isolated; a failed start is logged rather than crashing the application.

## Killswitch behavior

| Killswitch | Current effect |
|---|---|
| `disableSDK` | Canonical admission rejects events; initialization can stop early. |
| `disableTracing` | Tracer and auto-instrumentations shut down; request/span gates reject tracing data. |
| `disableMetrics` | Meter provider shuts down and metric APIs/events reject. |
| `disableTransport` | Router rejects sends until re-enabled. Rejection is not promised to become durable local queuing. |
| `disableProfiling` | Profiler stops and profile events reject. |
| `disableErrors` | Global handlers detach and error capture/events reject. |
| `disableLogs` | Logging subsystem stops and log events reject. |

The killswitch set has no dedicated replay or cron switch; those use feature/entitlement controls or the global SDK/transport switches.

## Sampling

Sampling families are traces, requests, errors, profiles, replays, and metrics. Decisions are deterministic using FNV-1a over a family-specific key. Per-route overrides are string prefixes and longest prefix wins. Missing family values fall through to the global rate. Zero always drops and one always samples.

The route lookup is currently a linear scan of configured prefixes. A radix trie is an architectural optimization recommendation for very large route maps, not current behavior.

Logs, messages, and cron check-ins do not have dedicated sampling-rate keys in `SamplingConfig`. They can still be controlled by features, entitlements, killswitches, tenant governance, limits, pressure, processors, and queues.

## Privacy

Supported privacy controls include pre-capture section gates, sensitive-header/field redaction, recursive value scrubbing, PII masking for email/phone/IP, middleware-safe header/query/body handling, span-attribute filtering, and a final transport scrub. Capture flags and scrubbing are different: capture decides whether a section is attached; scrub decides what to redact if attached.

There is no baked privacy policy and middleware cannot force section capture. If privacy fields are missing or malformed, the complete snapshot is rejected before telemetry starts or before a refresh swap. Application-defined free-form telemetry can still contain sensitive data, so backend scrubbing policy and final hooks remain important.

## Queueing, persistence, and delivery

Supported:

- bounded route queues and pre-init queue;
- critical-over-noncritical retention preference;
- configurable overflow strategy;
- route batching and payload splitting/drop for oversized events;
- retry for network, 408, 429, and 5xx failures;
- fixed/linear/exponential backoff and circuit health;
- fallback-only persistence for failed sends and shutdown residuals;
- TTL replay through the canonical pipeline;
- health counters.

Not guaranteed:

- Queue acceptance is not backend delivery.
- Critical events can be dropped when hard capacity contains only critical events.
- `criticalReserve` protects backend-configured slots from ordinary telemetry, but critical events can still be dropped once all hard capacity is critical;
- Persistence does not cover every in-memory event before first send.
- Delivery is at-least-once for persisted/retried data; duplicates are possible.
- The connection manager is a semaphore, not a true keep-alive socket pool.
- Shutdown and crash flush are bounded and can leave residual data.
