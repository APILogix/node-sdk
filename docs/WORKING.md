# Working with the SDK

This is the operations and implementation-status guide for the current source tree. It also reconciles older audit findings with the code now present.

## Operational model

1. Initialize once near process startup and await `createSDK()` or `init()`.
2. Treat capture as non-blocking and best-effort. Only `captureEvent()` exposes an acceptance receipt; acceptance still does not mean backend acknowledgement.
3. Inspect `getSDKHealth()` for initialization, per-route circuit state, queue/drop counts, memory, session, persistence, source-map, deduplication, and metric information.
4. Call `flush()` before a controlled handoff when the SDK must remain usable.
5. Call `shutdown()` during process termination. Inspect its result instead of assuming all telemetry was sent.
6. Use `crashFlush()` only on crash paths; it is bounded and deliberately skips subsystem/plugin teardown.


## Startup checklist

- Provide a non-empty API key. Set `baseUrl` or `SDK_BASE_URL` only when overriding the default SaaS endpoint.
- Await initialization before expecting logs/profiles or initialized subsystems.
- Initialize before importing heavily instrumented modules where load order matters.
- Set explicit `service`, `environment`, and deployment `release`; set application package overrides only when package discovery is not authoritative.
- Review remote route URLs, features, sampling, privacy, limits, tenant governance, entitlements, and killswitches.
- Keep body/header/response/query capture off unless approved.
- Verify `getSDKHealth()` from an application health or diagnostic endpoint without exposing its output to untrusted callers.

## Health and diagnosis

`getSDKHealth()` is the stable operational snapshot. Important fields:

| Field | Interpretation |
|---|---|
| `initialized` | A resolved client config exists. It does not prove routes are healthy. |
| `circuitState` | Comma-joined per-route circuit states, or `uninitialized`. Use route debug information internally when deeper diagnosis is needed. |
| `queueSize`, `queueDropped`, `queueDeadLetter` | The legacy/pre-init priority queue counters, not a complete sum of every route queue. |
| `memory` | Current pressure level and heap use/utilization. |
| `session` | Process session count, crash-free rate, and current session ID. |
| `pluginCount` | Registered plugin count after init. |
| `dedup` | Tracked and suppressed error-group counts. |
| `persistence` | File state, ACK discards, replay count/time, and most recent replay volume. |
| `sourceMaps` | Resolver cache and hit rate. |
| `metrics` | Registry instrument counts and total flushes. |

Use SDK debug logging only while diagnosing; telemetry previews and application context may still be sensitive. `setLogger()`, `setDebugMode()`, and `setLogLevel()` allow host logging integration and runtime verbosity control.

## Normal operation

### Remote configuration

Remote config changes propagate to controllers rather than rebuilding the whole SDK indiscriminately:

- killswitch changes invoke registered subsystem startup/shutdown handlers;
- sampling changes replace family rates;
- feature changes start or tear down registered subsystems;
- privacy changes update the scrubber;
- limit changes update limits, pressure monitoring, and tenant governance;
- transport changes use serialized build-then-swap;
- entitlement changes affect subsequent custom API calls.

The refresh loop is owned by the configuration manager and stopped during shutdown. Numeric backend values are locally bounded. An unavailable control plane begins from inert safe defaults; a successful compatibility init can derive a working fallback configuration.

### Backpressure and drops

Drops are expected safety behavior under invalid routes, disabled transport, queue capacity, excessive payload, serialization failure, tenant quota, rate limit, memory/GC/event-loop pressure, processor filtering, feature gates, or permanent HTTP rejection. Do not retry capture calls in application code: retries occur at the transport layer where appropriate, and application retries can amplify pressure.

Transport queues prefer fatal errors/logs and failed cron check-ins over ordinary events, but no class is lossless. The configured `criticalReserve` is not currently a dedicated queue slice; critical retention is implemented by evicting non-critical entries when possible.

### Network failure

Retryable failures are connection acquisition failure, fetch/network error, HTTP 408, 429, and 5xx. The route uses remote fixed/linear/exponential delay and a health circuit. Other 4xx responses are treated as permanent. Bearer-authenticated fetches use manual redirect handling, so redirects are not followed with credentials.

Retry does not add jitter. A fleet receiving the same failure can still synchronize around common delays; backend rate-limit responses and fleet rollout strategy should account for that.

### Persistence

Persistence is a fallback for failed batches and graceful-shutdown residuals, not a write-ahead log for all captures. Defaults are 10 MB, 10,000 entries, 24-hour TTL, and a one-second buffer debounce. Paths are platform-specific cache/temp locations and filenames are namespaced by an API-key hash prefix.

A backend ACK causes an asynchronous `eventId` discard. A process crash before discard is durable can replay a delivered event. Conversely, a crash while an event exists only in the in-memory queue can lose it. This is an at-least-once recovery mechanism with both duplicate and loss windows, not an exactly-once guarantee.

The implementation does not specify private modes on storage creation. Set a restrictive service account and umask/ACL, and treat the cache location as sensitive telemetry storage.

## Flush and shutdown runbook

For a rolling deployment:

1. Stop accepting new application traffic.
2. Wait for in-flight application requests to settle.
3. Call `flush()` if the SDK must remain available after a handoff; otherwise call `shutdown()` directly.
4. Inspect `ShutdownResult.completed`, `timedOut`, `remainingEvents`, `deadLetterCount`, and `stepErrors`.
5. Allow timed-out background cleanup to finish before attempting to initialize another SDK runtime in the same process.
6. Exit according to application policy; do not assume the SDK signal handler calls `process.exit()`.

`shutdown()` joins concurrent callers. It rejects new user events, tears down features, flushes the tracer and deferred pipeline, quiesces route batch managers, persists residuals, drains persistent writes, and resets instrumentations and global state. Each step is bounded and failures do not stop later cleanup.

For an uncaught crash, call `crashFlush()` only if the host's crash policy permits a short asynchronous delay. It drains pipeline/transport up to its deadline and swallows errors. It does not persist, call plugin teardown, or perform full cleanup. SIGKILL and abrupt runtime termination cannot be handled.

## Current performance characteristics

- Each accepted post-init event schedules one `setImmediate`. This keeps capture synchronous work short but adds one event-loop task and allocation pressure per event.
- Pipeline in-flight work is capped at 10,000.
- Route queue enqueue/drain/drop-oldest operations use ring buffers and are normally O(1); removing an interior non-critical event can shift entries.
- JSON serialization and byte-size checks happen in process. Gzip uses asynchronous zlib at best-speed, so the old claim of synchronous main-thread gzip is stale, but serialization can still produce event-loop pauses.
- Failed persisted-batch ACK discard reads and rewrites the NDJSON file and is O(N) per discard batch.
- Error stack parsing/fingerprinting begins synchronously on the capture path.
- Route sampling override lookup scans configured prefixes linearly.
- Connection concurrency is bounded globally and per route, but socket ownership remains with runtime fetch.

## Audit reconciliation

The older enterprise audit was useful at the time it inspected its source snapshot, but several conclusions no longer describe this tree. Findings below are classified by current executable behavior.

### Fixed

| Prior finding | Current status |
|---|---|
| Persisted events replayed repeatedly inside init retries | The observed duplicate loop is fixed operationally: persistence initialization is idempotent, replay occurs only after a successful legacy handshake, and replay uses the full pipeline in bounded/yielding batches. Persisted ACK entries are discarded after successful sends. At-least-once duplicates still exist for different reasons described below. |
| Cron events bypassed the pipeline | Fixed. Both public pre-init cron events and post-init `CronSubsystem` events emit through `processEvent`/`enqueueEvent`. |
| Metric convenience helpers bypassed killswitch and sampling | Fixed. All metric helpers use shared `admitMetric`, checking custom-metric entitlement, metrics killswitch, and deterministic sampling. |
| Batch manager had no retry/backoff/circuit breaker | Fixed. Retry config is used; route health has closed/open/half-open states and adaptive concurrency/batching. |
| Remote retry configuration unused | Fixed in the primary `BatchManager` path. |
| Transport update abandoned old batch-manager timers | Fixed with serialized candidate build, synchronous reference swap, old-manager shutdown, and residual migration. |
| Bearer token followed redirects | Fixed in the primary batch fetch with `redirect: 'manual'`. |
| `captureLog('log', ...)` could emit an unsupported level | Fixed: `log` becomes `info`; `warn` becomes `warning`. |
| EventEmitter missed prepend APIs | Fixed: `prependListener` and `prependOnceListener` are patched and restored. |
| Gzip was synchronous on the main thread | Fixed for compression itself: the batch path awaits promisified zlib gzip. JSON stringify remains synchronous. |
| Array `shift()` made route overflow quadratic | Fixed for the main per-route queues by ring-buffer storage. |

### Stale or overstated

| Prior finding | Current interpretation |
|---|---|
| Errors and crons both flush immediately | Overstated. Errors batch up to 100 with a one-second maximum wait and minimum batch one. Crons intentionally remain immediate with batch one/wait zero. |
| Every event is persisted and replayed after restart | Stale. Persistence is fallback-only after retryable send failure or shutdown residual. |
| Scope `extra` and `contexts` are unconditionally unsanitized | Stale/overstated. Extra/context setters reject dangerous object keys, and the current security scrubber recursively covers every non-metadata event section—including merged `extra` and `contexts`—at the transport boundary. These values are not fully scrubbed when stored in scope, and free-form data can still carry unrecognized secrets, so collection minimization remains necessary. |
| No route health or bounded concurrency exists | Stale. Health/circuit logic and semaphore limits exist. Calling the semaphore a socket pool, however, would be inaccurate. |
| Global instrumentation teardown is missing | Stale. Registration stores unregister/teardown handlers and resets EventEmitter and HTTP lifecycle patches. |
| A failed remote config necessarily sends to a real fallback URL | Stale. Baked-in routes use a reserved `.invalid` origin and transport starts disabled until real intent exists. |

### Architectural recommendations and remaining risks

These are not necessarily correctness bugs, but they matter at scale:

1. **Semaphore versus true keep-alive pool.** `ConnectionManager` grants concurrency leases; it does not create, retain, age, or health-check TCP/TLS connections. `transport.keepAlive` does not instantiate an SDK-managed agent pool. Runtime fetch may reuse connections, but that is not the same guarantee. A dedicated Undici dispatcher/agent with route-aware lifecycle would make keep-alive behavior explicit.
2. **Per-event `setImmediate`.** The canonical pipeline creates one task per accepted event. Consider a bounded work queue with batch draining while preserving receipt semantics and fairness.
3. **No OTLP exporter.** Traces and metrics are transformed to Pulse events. Add a separately owned OTLP exporter only if OTLP interoperability is a product requirement; do not label the current Pulse transport OTLP.
4. **Radix-trie route matching.** Sampling route overrides currently find the longest prefix by linear scan. A radix trie is recommended only for large route maps; the current map scan is simpler and correct for moderate configuration sizes.
5. **At-least-once duplicates.** A backend ACK lost in transit or a crash before asynchronous discard can resend the same `eventId`. Backend deduplication is mandatory for exactly-once effects.
6. **Persistence compaction.** ACK discard is full-file read/filter/rewrite. A WAL with checkpoints, segment tombstones, SQLite, or another indexed durable queue would scale better.
7. **Persistence permissions.** Declare restrictive directory/file modes where platforms support them instead of relying solely on process umask/ACL.
8. **Synchronous serialization and stack work.** JSON stringify and initial error stack/fingerprint work can still pause the event loop. Measure before adding worker offload; preserve ordering and shutdown ownership if changed.
9. **Retry jitter.** Configured delays lack jitter and can align a large fleet. Add bounded jitter while respecting server hints if fleet synchronization is observed.
10. **Tenant fairness.** Tenant quotas and LRU tracking exist, but route queues do not provide tenant round-robin scheduling. Add fair scheduling only if route-level FIFO causes measurable tenant starvation.
11. **Critical reserve wiring.** The queue schema exposes `criticalReserve`, but current retention uses critical eviction rather than reserved slots. Either wire the field into capacity accounting or remove/clarify it in the control-plane contract.
12. **Public/remote instrumentation schema alignment.** Auto-registration supports PostgreSQL and MySQL2 through compatibility casts even though the typed `InstrumentationConfig` does not declare those fields. Add typed fields before treating those remote knobs as a stable wire contract.
13. **Standalone factory consistency.** Some optional instrumentation factories expose options that are applied more fully in auto-registration than in the standalone wrapper. Keep examples on auto-registration or align factory behavior and tests.

## Capacity and acceptance testing

Before a high-volume release, measure rather than extrapolate guarantees:

- event rate by family with realistic payload sizes and sampling;
- event-loop delay from pipeline task count, JSON serialization, and stack parsing;
- route queue occupancy/drop behavior during sustained 429/5xx and open circuits;
- retry synchronization across multiple processes;
- 24-hour persistence replay/discard with maximum file size and slow/full filesystems;
- graceful shutdown with active spans and transport requests at each deadline;
- repeated init/config-refresh/shutdown cycles for leaked timers/listeners;
- tenant quota behavior with many IDs and default-tenant traffic;
- duplicate handling by backend `eventId`;
- privacy tests for headers, query, bodies, scope, breadcrumbs, span attributes, logs, and replay entries.

## Incident triage

**Transport outage:** check route circuit states, retry/failure counts, queue drops, and persistence write errors. Do not disable all SDK capture unless telemetry overhead is harming the application; route/feature killswitches provide narrower controls.

**Application latency regression:** compare event-loop delay with pipeline volume, sampling, body capture, error rate, and metric cardinality. Disable expensive optional instrumentation first, then lower sampling. Remember gzip is async but JSON stringify and stack parsing are not.

**Disk growth:** inspect persistence replay/discard/write-error counters and filesystem permissions. Repeated persistence without discard suggests transport failure or ACK/discard problems. Rotated `.bak` files are not an unlimited durable archive contract and need operational monitoring.

**Duplicate alerts/billing:** confirm backend deduplication by `eventId`, then inspect response-loss/retry and restart/replay counters. Do not generate a new ID during replay.

**Missing tenant data:** verify framework extraction (`x-tenant-id` or context), tenant quotas/default bucket, feature/sampling gates, and queue drops. Tenant governance may intentionally reject noisy tenants.

**Privacy incident:** activate the narrowest relevant killswitch, disable capture sections remotely, rotate exposed credentials, preserve necessary forensic logs securely, and validate transport/persistence copies. The SDK's scrubber reduces risk but is not a substitute for incident response or data classification.
