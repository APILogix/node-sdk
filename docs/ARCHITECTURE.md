# Architecture

This document describes the current `src` implementation. It separates explicit behavior from design intent and does not promise exactly-once delivery, lossless queues, or successful flushes under every failure mode.

## Runtime ownership

A process has one SDK client, one control-plane configuration manager, one feature controller, one killswitch engine, one sampling engine, one entitlement gate, one tenant governor, one transport router, and optional feature subsystems. Initialization is single-flight for the same API-key identity. Shutdown owns cleanup exclusively; a later initialization waits for timed-out background cleanup to finish.

The SDK owns an in-process OpenTelemetry tracer provider only when no compatible global provider/context setup is detected. Otherwise it reuses the global API and does not replace the existing provider. The SDK does **not** create an OTLP exporter. Its `PipelineSpanExporter` converts finished spans into Pulse `span` events and submits them to the canonical event pipeline.


## Initialization and control plane

Initialization proceeds in phases:

1. Validate options, resolve application package metadata, and install the client options/breadcrumb capacity.
2. Initialize the schema-versioned remote configuration manager. It can use baked-in safe defaults when the control plane is unavailable.
3. Initialize killswitch, deterministic sampling, feature, limits, tenant, privacy, and entitlement controllers.
4. Build the multi-route transport router. Initialization waits for an older router to shut down before publishing the replacement.
5. Perform the backward-compatible `/v1/init` handshake and merge baked-in, remote, legacy, user, plan, and safety-bound values.
6. Initialize fallback persistence and replay undelivered events through the full pipeline in batches of 100, yielding between batches.
7. Register feature-owned tracing, metrics, error, logging, profiling, cron, and session subsystems.
8. Subscribe controllers and transport to config diffs, then start the refresh loop.

Baked-in transport routes have no real URL and transport is killed by default. A valid remote route set or the compatibility bridge derived from a successful legacy init is required before sending. Numeric remote values are clamped to local safety floors/ceilings.

## Canonical event pipeline

The canonical fresh-event path is:

```text
capture helper
  → synchronous admission and eventId assignment
  → pre-init priority buffer OR one setImmediate task
  → feature/killswitch/limit/load-pressure gates
  → tenant admission
  → attribute limits
  → normalize
  → request/trace/session context enrichment
  → error deduplication
  → scope merge
  → optional source context
  → plugin processEvent
  → user eventProcessors
  → user beforeSend
  → plugin beforeSend
  → reapply immutable client metadata
  → TransportRouter route resolution
  → per-route bounded queue and batching
  → transport-boundary sanitize/scrub
  → JSON serialization and gzip
  → HTTP send/retry/health accounting
  → ACK discard or failure persistence
```

`captureEvent()` synchronously returns an `EventReceipt`. Its `accepted` flag means only that synchronous admission succeeded. Processing is deferred with one `setImmediate` per accepted post-init event; `processed` resolves after the asynchronous pipeline either routes or drops it. The pending-task set is capped at 10,000.

Pre-init events use a separate three-tier `EventQueue`; they receive IDs/timestamps but do not run the expensive pipeline until init drains them. Replayed persistence events and pre-init events are submitted back through `processEvent`, so current feature, privacy, plugin, processor, tenant, and pressure rules apply.

Capture helpers may perform earlier family-specific gates. For example, error, profile, replay, and metric APIs make deterministic sampling decisions, and entitlement-controlled helpers can no-op before pipeline admission. Trace root sampling is performed by the parent-based tracer sampler; finished sampled spans (and error spans) enter the pipeline through `PipelineSpanExporter`.

### Normalization, security, and metadata

The pipeline normalizes required fields and enriches correlation before user extension hooks. Scope data merges global/isolated scope and request context. Source-context file reads are optional, best-effort, and time-bounded.

Plugin processors and event processors may transform or drop events. User and plugin `beforeSend` hooks run before routing. Each extension call is time-bounded and isolated; a throw or timeout is logged and processing continues with the last event. A `null` result drops it.

The final pipeline stage overwrites `metadata` with the frozen client metadata. This makes `applicationName`, `applicationVersion`, `sdkName`, `sdkVersion`, `service`, `environment`, and `release` authoritative even if an extension changed them. The batch manager then applies the security scrubber/sanitizer again before serialization. This is defense in depth, not a reason to collect unnecessary sensitive data.

## Traces and aggregation

Manual and automatic spans are OpenTelemetry spans. `PulseSpan` is a thin safety/ergonomics wrapper; the readable OpenTelemetry span remains the exporter source of truth. Span enrichment, request/tenant/session correlation, exclusive duration, links, events, attributes, and SDK metadata are converted into a Pulse `span` event in `PipelineSpanExporter`.

The trace aggregator also reconstructs a hierarchy and emits `trace` documents when a root completes or a trace is swept as partial. Both `span` and `trace` use the Pulse `traces` route. There is no OTLP network exporter in this implementation; all export goes through Pulse event routing.

If the process already has a global OpenTelemetry provider/context setup, the SDK avoids registering a second provider. Built-in propagation uses W3C Trace Context (and baggage according to internal defaults). SDK transport calls suppress tracing and internal URLs are ignored to prevent export recursion.

## Routing and batching

Ten event types map to eight enterprise routes:

| Event types | Route owner | Forced path |
|---|---|---|
| `error`, `message` | `errors` | `/v1/errors` |
| `span`, `trace` | `traces` | `/v1/traces` |
| `request` | `requests` | `/v1/requests` |
| `metric` | `metrics` | `/v1/metrics` |
| `log` | `logs` | `/v1/logs` |
| `profile` | `profiles` | `/v1/profiles` |
| `cron_checkin` | `crons` | `/v1/checkins` |
| `replay` | `replays` | `/v1/replays` |

The registry forces the endpoint path onto the configured URL and removes search/fragment data. Missing request routes fall back to the traces URL and missing replay routes fall back to the logs URL, but still use their own forced path. Unconfigured routes use a reserved `.invalid` placeholder and are rejected locally.

Every route owns a bounded ring-buffer queue and `BatchManager`; all routes share one `ConnectionManager` and health monitor. Remote batch sizes, intervals, timeouts, priorities, queue sizes, and concurrency values are clamped against route defaults and SDK safety bounds. Cron intentionally uses batch size one and zero wait.

### Critical retention

The transport queue identifies only these events as critical:

- `error` with `severity: 'fatal'`;
- `log` with `level: 'fatal'`;
- `cron_checkin` with `status: 'error'`.

When full, an incoming critical event may evict the oldest non-critical event under either overflow policy. Ordinary events never evict critical events. Under `drop_oldest`, ordinary ingress evicts only a non-critical event. If a queue contains only critical events, a new critical event can still be dropped: this is preferential retention, not losslessness.

The wire schema includes `transport.queue.criticalReserve`, but the current `TransportEventQueue` does not carve out that number of dedicated slots. Its actual protection is the critical-eviction rule above. The separate pre-init queue uses broader tiers (`error` critical, request/span high, other normal) and fixed proportional capacities.

## Atomic transport reconfiguration

Transport reconfiguration is serialized on a promise chain and follows build-then-swap:

1. Build and validate a complete candidate registry, queues, health monitor, connection limiter, and batch managers without touching live references.
2. Drain old queued events.
3. Commit all live references synchronously, so `send()` observes either the complete old runtime or complete new runtime.
4. Migrate drained events to the new runtime.
5. Shut down detached batch managers, collect residual/in-flight failures, and migrate those once.

A candidate-build failure leaves the old runtime intact. Consecutive refreshes cannot interleave their commits. This removes the older clear-and-repopulate window and disposes old manager timers; it does not claim that every event survives capacity changes or a process crash during migration.

## Retry, backoff, and circuit health

The batch manager treats network failures, connection-acquisition failures, HTTP 408, 429, and 5xx as retryable. Other 4xx responses are permanent rejections and are dropped rather than persisted forever. Retry behavior follows remote `enabled`, `maxRetries`, `backoff`, and `baseDelayMs`:

- fixed: `baseDelayMs`;
- linear: `baseDelayMs × attempt`;
- exponential: `baseDelayMs × 2^(attempt-1)`;
- linear/exponential delays are capped at 30 seconds.

No jitter is currently added, so deployments should not describe retry synchronization as eliminated. Failed events are persisted best-effort before delayed in-memory retry when persistence governance admits them.

Route health tracks recent failures and a bounded latency histogram. Ten failures in a 60-second window, or a failed half-open probe, opens the circuit. Probe backoff begins at one second and doubles to 60 seconds. Degraded routes reduce concurrency and batch size; unavailable routes delay sends and probe half-open. The health snapshot exposes circuit state, failures, latency, queue, sent/failed/dropped/retry totals, and connection concurrency.

`ConnectionManager` is a pair of global/per-route semaphores with timed acquisition. Despite “pool” names in stats, it does not own sockets or implement a true keep-alive agent pool. Actual socket reuse, if any, belongs to runtime `fetch`/Undici behavior. The remote `keepAlive` field is not converted into a dedicated SDK connection pool.

## Tenant governance

Tenant governance is centralized in the pipeline, after feature admission and before expensive normalization. Tenant identity is resolved from event `tenantId`, error/context data, tags, or request context. There is one SDK runtime and one transport set for the process—no per-tenant exporters or SDK instances.

When enabled remotely, the tenant governor maintains a bounded LRU map of tenant windows. Each tenant receives `quotaPerWindow`; high-priority events may consume an additional `criticalReserve`. Idle entries are cleaned and the least-recently-used tenant is evicted when tracking reaches `maxTenantsTracked`. Events without an ID share `_default`.

This protects pipeline admission from noisy neighbors, but “fair scheduling” is only reserved in the tenant options and is not a transport scheduler. Once events enter a route queue, that queue is route-oriented rather than tenant round-robin.

## Persistence and delivery semantics

Persistence is fallback-only and transport-owned:

- successful capture does not synchronously write every event;
- retryable send failures persist admitted events before in-memory retry;
- graceful shutdown persists transport residuals that could not be delivered;
- a 2xx response triggers asynchronous discard by `eventId`;
- non-retryable 4xx batches are not persisted;
- startup replays valid entries through the full pipeline;
- persistence governance can shed non-critical durability work under pressure.

The file is bounded by event count, size rotation, and a 24-hour default TTL. It uses NDJSON, a serialized write chain, chunked stringify during flush, and temporary-file rename for rewrites. Each filesystem operation is time-bounded. ACK discard reads and rewrites the current file, so it is O(N) per acknowledged persisted batch and remains an architectural scaling limit.

The contract is at-least-once only for events that reach fallback persistence. Events can be lost in the in-memory queue-before-send window, on queue/pressure drops, or when durability fails. Duplicates occur when the backend accepted a request but its response was lost, or when the process exits before an ACK discard is durable. `eventId` survives retry/replay and the backend must deduplicate it for exactly-once effects.

Persistence location is OS-specific (`LOCALAPPDATA`, macOS caches, XDG/home cache, or the temp directory). The storage implementation does not currently pass explicit private file modes; deployment permissions and umask therefore matter.

## Lifecycle ownership

`flush()` owns this order without destroying the SDK:

1. drain all `setImmediate` pipeline tasks;
2. flush all transport routes;
3. flush persistence buffers.

`shutdown()` is single-flight and returns a structured result. It marks shutdown, runs bounded pre-shutdown hooks, rejects new pre-init queue events, tears down feature subsystems, flushes tracing, drains the event pipeline, flushes/shuts down transport, persists residuals, shuts persistence, and resets global controllers, instrumentations, handlers, timers, and client state. Each step is isolated. If the public deadline expires, the result is timed out while the same cleanup retains exclusive ownership in the background; re-init waits for it.

`crashFlush()` only races pipeline and transport draining against a hard deadline. It intentionally skips plugins, subsystem teardown, singleton resets, and persistence flush. It swallows failures so it cannot mask the original crash.

## Explicit non-guarantees

- No OTLP exporter or OTLP wire compatibility.
- No exactly-once delivery.
- No guarantee that accepted events reach transport or backend.
- No lossless queue under hard capacity, pressure, shutdown deadline, or process crash.
- No true SDK-managed keep-alive connection pool.
- No per-tenant fair queue scheduler.
- No jitter in retry delay.
- No O(1) persistence ACK compaction.
- No claim that `flush()` can override remote killswitches, permanent HTTP rejection, open circuits, or unavailable filesystems.