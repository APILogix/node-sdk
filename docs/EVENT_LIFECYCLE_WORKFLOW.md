# SDK Event Lifecycle Workflow

This document details the complete function-by-function execution path of an event from the moment it is captured until it is successfully transported to the backend endpoints.

## Phase 1: Ingestion & Admission

The journey begins when any telemetry (Error, Span, Request, Metric) is passed to the core pipeline via `enqueueEvent()`. This phase is **synchronous** and its main goal is to protect the host application from performance degradation.

### Function: `enqueueEvent(rawEvent)`
*(Located in `src/core/event-pipeline.ts`)*

1. **Shutdown Gate**: Rejects the event if the SDK is currently draining/shutting down.
2. **Killswitch Gate**: `KillswitchEngine.getInstance().isSDKDisabled()` is checked to see if the SDK has been disabled remotely.
3. **Rate Limiting**: `LimitsEngine.getInstance().admitEvent()` enforces token-bucket rate limiting.
4. **Memory Pressure Gate**: `isCriticalMemoryPressure()` checks the host Node.js process heap. If heap usage exceeds `92%`, low-priority events (like metrics) are dropped immediately. Only high-priority events (errors, spans) survive.
5. **Load Shedding**: `loadShedder.shouldShed(event)` drops telemetry under adaptive system pressure.
6. **Pre-init Buffering**: If the SDK `init()` hasn't completed, the event is added to a pre-init memory queue (`eventQueue.add()`).
7. **Deferral**: The event is accepted, an `EventReceipt` is returned, and full processing is deferred to the Node.js event loop via `setImmediate()` to prevent blocking the user's execution thread.

---

## Phase 2: Asynchronous Processing

Once the Node.js event loop ticks, the pipeline continues processing in the background.

### Function: `processEventAsync(event)`
*(Located in `src/core/event-pipeline.ts`)*

1. **Feature Toggles**: `isFeatureEnabled(event, config)` checks remote configuration to ensure this specific event type (e.g., `requests`, `metrics`) hasn't been disabled via remote config.
2. **Limit Enforcement**: `LimitsEngine.enforceAttributeLimits(event)` truncates massive arrays or deeply nested objects.
3. **Normalization**: `normalizeEvent(event, client.metadata)` fills in missing foundational fields (OS, SDK version, host data).
4. **Sanitization**: `SecurityScrubber.getInstance().scrub(event)` applies PII redaction rules to body, headers, and fields based on remote config privacy rules.
5. **Enrichment**: `enrichFromContext(event)` automatically tags the event with the active `traceId`, `spanId`, and relevant breadcrumbs.
6. **Deduplication**: `errorDeduplicator.isDuplicate()` drops the event if it's a rapidly repeating identical error.
7. **Scope Application**: `applyScopeToEvent(event)` merges user context, tags, and extra data from the global or request-local scope.

### Function: Hooks & Callbacks
Within `processEventAsync`, user and plugin code is executed with strict timeouts:

1. **Plugin Processors**: `plugin.processEvent(event)`
2. **User Processors**: `client.eventProcessors`
3. **User `beforeSend`**: `client.options.beforeSend(event)` — The user has a final chance to mutate or drop the event.
4. **Plugin `beforeSend`**: `plugin.beforeSend(event)`

---

## Phase 3: Routing & Transport

If the event survives all hooks and sanitizers, it is handed off to the transport layer.

### Function: `TransportRouter.getInstance().send(event)`
*(Located in `src/transport/transport-router.ts`)*

1. **Route Resolution**: `this.registry.resolve(event)` maps the event type to its designated `EnterpriseRoute`. 
   - `error` → `errors`
   - `request` → `requests`
   - `span` → `traces`
   - `replay` → `replays`
2. **Queue Assignment**: The event is handed to the specific `BatchManager` for that route via `manager.enqueue(event)`.

### Function: `BatchManager.enqueue(event)`
*(Located in `src/transport/batch-manager.ts`)*

1. **Local Queue**: The event enters a `TransportEventQueue` bounded by a maximum size (e.g., 50,000 for traces/requests). If the queue is full, the oldest events are dropped.
2. **Batch Formation**: The `BatchManager` waits until either:
   - The queue reaches `maxBatchSize` (e.g., 500 requests).
   - The wait timer reaches `maxWaitTimeMs` (e.g., 5000ms).

### Function: `ConnectionManager` & Network Flush
*(Located in `src/transport/connection-manager.ts`)*

1. When a batch is ready, the `BatchManager` requests an HTTP socket from the `ConnectionManager`.
2. The `ConnectionManager` respects global and route-specific connection limits (e.g., max 50 concurrent requests for the `requests` route).
3. The HTTP payload is compressed (Gzip/Brotli) and sent via a `POST` request to the specific backend endpoint (`/v1/requests`, `/v1/traces`, etc.).
4. **Crash Recovery Persistence**: In parallel with the network send, `persistenceGovernor.shouldPersist(event)` writes critical events to disk (`PersistentStorage`) so they can be recovered if the Node process crashes before the HTTP request completes.
