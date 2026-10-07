# Implementation-Level Architecture Audit: Offline Queue & Telemetry Delivery System

> **Audit Target:** `sdk-node`  
> **Source of Truth:** Active SDK Source Code (`src/`, `tests/`)  
> **Operational Guarantee:** Read-only inspection; zero code modifications performed.

---

## Table of Contents
1. [Primary Objective & Architectural Definition](#1-primary-objective--architectural-definition)
2. [Repository File Audit](#2-repository-file-audit)
3. [Complete Event Lifecycle & Data Flow](#3-complete-event-lifecycle--data-flow)
4. [Memory vs. Disk Architecture](#4-memory-vs-disk-architecture)
5. [Storage Implementation & Disk Engine](#5-storage-implementation--disk-engine)
6. [Startup Recovery & Replay Pipeline](#6-startup-recovery--replay-pipeline)
7. [Network Failure & Error Handling Sequence](#7-network-failure--error-handling-sequence)
8. [Error Classification Matrix](#8-error-classification-matrix)
9. [Retry Mechanism & Backoff Engine](#9-retry-mechanism--backoff-engine)
10. [Queue Limits & Capacity Ceilings](#10-queue-limits--capacity-ceilings)
11. [Queue Saturation & Overflow Strategies](#11-queue-saturation--overflow-strategies)
12. [Persistence Failure & Fault Tolerance](#12-persistence-failure--fault-tolerance)
13. [Serialization Engine & Payload Bisection](#13-serialization-engine--payload-bisection)
14. [Compression Pipeline & Disk Interaction](#14-compression-pipeline--disk-interaction)
15. [Delivery Semantics & Duplicate Analysis](#15-delivery-semantics--duplicate-analysis)
16. [Comprehensive Event Loss Audit](#16-comprehensive-event-loss-audit)
17. [Graceful Shutdown & Signal Orchestration](#17-graceful-shutdown--signal-orchestration)
18. [Serverless & Ephemeral Runtimes Analysis](#18-serverless--ephemeral-runtimes-analysis)
19. [Concurrency & Thread Safety](#19-concurrency--thread-safety)
20. [Memory Pressure & Load Shedding](#20-memory-pressure--load-shedding)
21. [Priority Tiers & Invariant Protection](#21-priority-tiers--invariant-protection)
22. [Event Loop, Timers & Worker Threads](#22-event-loop-timers--worker-threads)
23. [Observability, Introspection & Metrics](#23-observability-introspection--metrics)
24. [Configuration Reference & Safety Ceilings](#24-configuration-reference--safety-ceilings)

---

## 1. Primary Objective & Architectural Definition

### What does "Offline Queue" mean in this SDK?

In this SDK, the term **"offline queue"** does **NOT** refer to a single monolithic queue or a simple SQLite/local database. Instead, it refers to a **hybrid, dual-stage, memory-first architecture with fallback-only disk persistence**:

```
                                      ┌─────────────────────────────────────────────────────────────┐
                                      │                      PRE-INIT STAGE                         │
                                      │                                                             │
Captured Event ──[!client.initialized]─► EventQueue (In-Memory 3-Tier Priority Array)              │
                                      └──────────────────────────────┬──────────────────────────────┘
                                                                     │ client.init()
                                                                     ▼
                                      ┌─────────────────────────────────────────────────────────────┐
                                      │                     POST-INIT STAGE                         │
                                      │                                                             │
Pipeline-Processed ──[client.initialized]─► TransportRouter                                         │
Event                                                │                                              │
                                                     ▼                                              │
                                        TransportEventQueue (Per-Route Ring Buffer)                 │
                                                     │                                              │
                                                     ▼                                              │
                                        BatchManager (HTTP Send Engine)                             │
                                      └──────┬───────────────────────┬──────────────────────────────┘
                                             │                       │
                                    [HTTP 2xx (Success)]      [HTTP Fail / Network / Shutdown]
                                             │                       │
                                             ▼                       ▼
                                   persistentStorage.discard()  persistentStorage.persistBatch()
                                   (Remove from Disk / Buffer)  (Flush to NDJSON File on Disk)
```

### Queue Capabilities Matrix

| Architectural Feature | Status in Codebase | Implementation Details / Concrete Source Location |
|---|---|---|
| **In-Memory Queue** | **YES (Dual)** | `EventQueue` in [queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/queue.ts#L39-L54) (pre-init) & `TransportEventQueue` in [transport-event-queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-event-queue.ts#L28-L60) (post-init). |
| **Persistent Queue** | **YES (Fallback)** | `PersistentStorage` in [persistent-storage.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L110-L144). Fallback-only for failed sends and shutdown drain. |
| **Disk-Backed Queue** | **YES (Fallback)** | Events written to local disk only when network fails or during graceful process shutdown. |
| **Filesystem Storage** | **YES** | Local NDJSON file written via `fs/promises` (`appendFile`, `writeFile`, `rename`, `readFile`). |
| **Retry Queue** | **YES (Dual)** | `retryQueue: Event[]` in [queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/queue.ts#L41) & `requeueFront()` in [transport-event-queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-event-queue.ts#L118-L188). |
| **Failed-Event Queue** | **YES** | Failed batches enter `BatchManager.retryOrRetain()` and are requeued at the front of the route ring buffer. |
| **Batch Queue** | **YES** | `BatchManager` in [batch-manager.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L61-L120) manages batch accumulation and route timers. |
| **Durable Queue** | **YES (Conditional)** | Guaranteed crash recovery for critical errors; adaptive durability for lower-tier telemetry governed by `PersistenceGovernor`. |
| **Recovery Queue** | **YES** | Events replayed from disk on startup are re-injected into the pipeline via `replayBufferedEvents()` in [init.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts#L620-L627). |
| **Shutdown Queue** | **YES** | Remaining events in `TransportRouter` queues and pre-init `eventQueue` are drained into `PersistentStorage` during step 13 of shutdown. |
| **Startup Replay** | **YES** | `PersistentStorage.replay()` executed during `init()`, replaying valid unexpired events before normal capture begins. |
| **Offline Detection** | **YES** | Dynamic circuit-breaker tracking in `HealthMonitor` ([health-monitor.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/health-monitor.ts#L29-L81)) switches routes to `UNAVAILABLE` and `OPEN`. |
| **Network Failure Detection** | **YES** | `BatchManager.sendBatch()` catches network fetch errors, timeouts, aborts, and classifies 5xx/429/408 HTTP statuses. |
| **Queue Persistence** | **YES** | Bounded NDJSON file append with serialized async `writeChain`. |
| **Queue Restoration** | **YES** | Asynchronous startup restoration in [init.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts#L226) and [persistent-storage.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L352-L408). |
| **Queue Expiration (TTL)** | **YES** | On-disk TTL enforcement (`eventTtlMs`, default 24h) and in-memory retention age cap (`MAX_BATCH_RETENTION_AGE_MS = 300_000`, 5 mins). |
| **Queue Size Limits** | **YES** | Ring buffer capacity (`maxSize`, default 10,000), pre-init capacity (`maxQueueSize`, default 100,000), disk limits (`maxEvents: 10,000`, `maxFileSizeBytes: 10MB`). |
| **Event Dropping** | **YES** | Explicit dropping on queue full, retry exhaustion, payload size overflow, stale batch age, pipeline saturation, and load shedding. |
| **Priority-Based Dropping** | **YES** | 3-tier shedding in `EventQueue`, critical-slot reservation (`criticalReserve`) in `TransportEventQueue`, 4-tier admission in `LoadShedder`. |

---

## 2. Repository File Audit

The following table catalogues every source file in the SDK that directly participates in queueing, storage, transport, batching, retry, or recovery:

| File Path | Role in Telemetry & Offline Delivery | Key Classes / Functions / Symbols | Line Count |
|---|---|---|---|
| [persistent-storage.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts) | Core filesystem persistence engine (NDJSON read/write/discard/replay). | `PersistentStorage`, `safeAtomicRename`, `withIoTimeout` | 705 |
| [persistence-governor.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistence-governor.ts) | Durability tier classification, per-minute disk rate limiter, pressure matrix. | `PersistenceGovernor`, `DurabilityTier`, `shouldPersist` | 285 |
| [batch-manager.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts) | Per-route batching, timer-driven flush, HTTP dispatch, retries, persistence triggers. | `BatchManager`, `retryDelay`, `persistOnFailure`, `discardOnSuccess` | 831 |
| [transport-event-queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-event-queue.ts) | Post-init per-route bounded ring buffer with critical reserve and O(n+k) prepend. | `TransportEventQueue`, `requeueFront`, `findOldestNonCritical` | 272 |
| [queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/queue.ts) | Pre-init 3-tier priority queue (`critical`, `high`, `normal`) and retry buffer. | `EventQueue`, `eventQueue`, `getPriority` | 327 |
| [transport-router.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-router.ts) | Singleton router managing 10 enterprise routes, health monitor, connection pool. | `TransportRouter`, `sendBatch`, `drainAllQueues`, `shutdown` | 458 |
| [connection-manager.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/connection-manager.ts) | Global and per-route connection concurrency semaphores. | `ConnectionManager`, `Semaphore`, `acquire`, `release` | 152 |
| [health-monitor.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/health-monitor.ts) | Route circuit breaker (`CLOSED`, `OPEN`, `HALF_OPEN`) and backoff tracker. | `HealthMonitor`, `RouteHealth`, `canSend`, `recordFailure` | 226 |
| [load-shedder.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/load-shedder.ts) | 4-tier priority admission (`p0`..`p3`) with correlation-group integrity. | `LoadShedder`, `CorrelationGroupTracker`, `shouldShed` | 345 |
| [event-pipeline.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/event-pipeline.ts) | Async non-blocking ingestion pipeline (`setImmediate`), pre-init buffer check. | `enqueueEvent`, `processEventAsync`, `drainPendingEventProcessing` | 723 |
| [init.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts) | SDK bootstrap, parallel disk initialization, startup event replay. | `init`, `replayBufferedEvents`, `filterBufferedEvents` | 668 |
| [lifecycle.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts) | Graceful shutdown (14-step orchestrator), signal handlers, residual disk drain. | `shutdown`, `flush`, `emergencyFlush`, `registerSignalHandlers` | 645 |
| [retry-classifier.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/retry-classifier.ts) | Authoritative error classification for control-plane initialization and recovery. | `classifyError`, `isRetryableError`, `isPermanentError` | 86 |
| [recovery-worker.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/recovery-worker.ts) | Background worker retrying SDK init/remote config when initial boot fails. | `BackgroundRecoveryWorker`, `executeAttempt`, `scheduleNextAttempt` | 203 |
| [serialization-pool.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-pool.ts) | Dedicated worker-thread pool for non-blocking JSON serialization & gzip. | `SerializationPool`, `serializeBatch`, `fallbackSerializeBatch` | 233 |
| [compression.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/compression.ts) | Asynchronous gzip and brotli stream compression wrappers (`zlib`). | `compressGzip`, `compressBrotli` | 72 |
| [config-cache.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/config-cache.ts) | Deprecated disk cache for remote configuration. | `saveConfigCache`, `loadConfigCache` | 113 |
| [defaults.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/constants/defaults.ts) | Safe default configurations (`DEFAULT_TRANSPORT`, `DEFAULT_OFFLINE_QUEUE`). | `DEFAULT_TRANSPORT`, `DEFAULT_OFFLINE_QUEUE`, `DEFAULT_LIMITS` | 323 |
| [limits.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/constants/limits.ts) | Hard safety bounds and ceilings for queue capacities and persistence. | `SAFETY_CEILINGS` | 83 |
| [config-validator.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts) | Authoritative schema validator for remote config and offline queue parameters. | `validateOfflineQueue`, `assertRemoteConfig` | 631 |

---

## 3. Complete Event Lifecycle & Data Flow

### 3.1 Normal Happy-Path Flow

```
Application API Call (e.g., captureException, captureRequest)
  │
  ▼
[enqueueEvent() in event-pipeline.ts]
  ├─ Gate 1: Check isSDKShuttingDown() ──► Reject if true (unless fatal crash)
  ├─ Gate 2: Check pipelineDraining ──► Reject if true (unless fatal crash)
  ├─ Gate 3: Check client.getState() === 'disabled' or KillswitchEngine.isSDKDisabled()
  ├─ Gate 4: Synchronous Context Injection (traceId, spanId, requestId from AsyncLocalStorage)
  ├─ Gate 5: QuotaController.shouldAdmit(priority) ──► Reject if quota exhausted
  ├─ Gate 6: LoadShedder.shouldShed(candidateEvent) ──► Reject if under pressure
  │
  ├─► Branch: IF !client.initialized:
  │     └─► Enqueue to eventQueue (In-memory 3-tier queue in queue.ts)
  │         └─► Returns acceptedSyncReceipt(eventId)
  │
  └─► Branch: IF client.initialized:
        ├─► Check pendingPipelines.size >= 10_000 ──► Reject if overloaded
        ├─► Return acceptedReceipt(eventId, pendingPromise)
        │
        ▼ (Deferred via setImmediate)
[processEventAsync() in event-pipeline.ts]
  ├─ 1. Check feature enabled (ConfigManager.isFeatureEnabled)
  ├─ 2. Check EntitlementGate.isAllowed(eventType)
  ├─ 3. Check SamplingEngine.isSampled(event)
  ├─ 4. Check TenantGovernor.admit(tenantId)
  ├─ 5. LimitsEngine.enforceAttributeLimits(event)
  ├─ 6. normalizeEvent() & enrichFromContext()
  ├─ 7. Error & Trace Deduplication (errorDeduplicator, traceDeduplicator)
  ├─ 8. applyScopeToEvent()
  ├─ 9. attachSourceContext() (error stack frames)
  ├─ 10. Plugin processEvent() hooks (timeout: 50ms)
  ├─ 11. User-registered EventProcessors (timeout: 50ms)
  ├─ 12. beforeSend() hooks (user & plugin, timeout: 100ms)
  ├─ 13. Quota check before routing
  │
  ▼
[TransportRouter.send(event) in transport-router.ts]
  ├─ 1. RouteRegistry.resolve(event) ──► Maps event type to 1 of 10 routes (e.g., 'errors')
  ├─ 2. Fetch Route's BatchManager
  │
  ▼
[BatchManager.enqueue(event) in batch-manager.ts]
  ├─ 1. TransportEventQueue.enqueue(event) ──► Enters route ring buffer (in-memory)
  ├─ 2. IF queue.size() >= effectiveMaxBatchSize ──► pump() immediately
  └─ 3. ELSE ──► ensureTimer() (schedules setTimeout for flushIntervalMs)
  │
  ▼
[BatchManager.pump() in batch-manager.ts]
  ├─ 1. Check HealthMonitor.canSend(route) ──► Abort pump if route circuit is OPEN
  ├─ 2. Check Concurrency Limits (ConnectionManager & HealthMonitor scale)
  ├─ 3. TransportEventQueue.drain(targetBatchSize) ──► Pops batch of SDKEvent[]
  │
  ▼
[BatchManager.sendBatch(batch) in batch-manager.ts]
  ├─ 1. ConnectionManager.acquire(route) ──► Wait for Semaphore lease
  ├─ 2. SecurityScrubber.scrubBatch()
  ├─ 3. SerializationPool.serializeBatch():
  │      ├─ Primary: Worker thread JSON stringify + zlib compressGzip()
  │      └─ Fallback: Main thread safeJsonStringify() + compressGzip()
  │      └─ Check maxPayloadBytes (4MB): if exceeded, bisect batch!
  ├─ 4. Construct HTTP POST headers (Content-Encoding: gzip, Authorization: Bearer, X-Route)
  ├─ 5. fetchImpl(route.url, { method: 'POST', body, signal, ... })
  │
  ▼
[Ingestion Server returns HTTP 200 OK]
  ├─ 1. HealthMonitor.recordSuccess(route, latency) ──► Closes circuit if HALF_OPEN
  ├─ 2. Release ConnectionLease
  ├─ 3. Clear retryAttempts and firstAttemptTimestamps for all batch eventIds
  ├─ 4. CostGovernor.recordBytesSent()
  └─ 5. BatchManager.discardOnSuccess(batch):
         └─► PersistentStorage.discard(batch) ──► Removes acknowledged eventIds from disk/buffer!
```

---

### 3.2 Network Failure & Offline Flow

```
Fetch HTTP Request Fails (Network Error / Timeout / Abort / HTTP 5xx / HTTP 429 / HTTP 408)
  │
  ▼
[BatchManager.sendBatch() Error Catch / Status Check]
  │
  ├─ 1. HealthMonitor.recordFailure(route)
  │      └─ Increments failure count; if >= 10 in 60s, circuit trips to OPEN for 1s..60s
  │
  ├─ 2. BatchManager.persistOnFailure(batch, reason)  <─── FALLBACK PERSISTENCE TRIGGER
  │      │
  │      ├─► Filter batch via PersistenceGovernor.shouldPersist(event):
  │      │     ├─ Critical (errors/crashes): ALWAYS true (100% persisted)
  │      │     ├─ Important (spans/requests): Check pressure matrix + per-minute budget
  │      │     └─ Transient (metrics/logs): Check pressure matrix + per-minute budget
  │      │
  │      └─► IF survivable events > 0:
  │            └─► PersistentStorage.persistBatch(survivable)
  │                  ├─ Push to PersistentStorage.buffer
  │                  ├─ Check maxEvents (10,000) ──► rotate() if full
  │                  └─ scheduleFlush() ──► 1000ms debounced flush to disk (NDJSON)
  │
  ├─ 3. BatchManager.retryOrRetain(batch, retryAfterMs)
  │      │
  │      ├─ Check now - firstAttemptTimestamps > 300_000ms (5 mins):
  │      │     └─► DROP stale batch (prevents poison-pill infinite loops)
  │      │
  │      ├─ Check attempt > maxRetries (default 3):
  │      │     └─► DROP exhausted batch (retained only on disk if persisted in step 2)
  │      │
  │      ├─ Calculate retryDelay:
  │      │     └─ Math.min(30_000, baseDelay * 2^(attempt-1)) * (0.8..1.2 jitter)
  │      │
  │      └─ Schedule retry timer: setTimeout(() => { ... }, delayMs).unref()
  │            │
  │            ▼ (When timer expires)
  │         TransportEventQueue.requeueFront(retryable)  <─── PREPEND TO MEMORY QUEUE
  │         BatchManager.ensureTimer(true)
  │
  └─ 4. BatchManager.pump()
         └─ Next pump tick attempts re-delivery when HealthMonitor allows.
```

---

## 4. Memory vs. Disk Architecture

The queue architecture is **Hybrid Type C: In-Memory Primary with Fallback Disk Persistence**:

```
                       ┌───────────────────────────────┐
                       │          APPLICATION          │
                       └──────────────┬────────────────┘
                                      │
                                      ▼
                       ┌───────────────────────────────┐
                       │         MEMORY QUEUE          │
                       │   TransportEventQueue (Ring)  │
                       └──────────────┬────────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │ HTTP In-Flight Dispatch │
                         └────────────┬────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
           [Network Available]                 [Network Unavailable / Crash]
                    │                                   │
                    ▼                                   ▼
             Ingestion Server                  ┌─────────────────┐
             (Delivered 2xx)                   │ PERSISTENT DISK │
                    │                          │  NDJSON File    │
                    ▼                          └────────┬────────┘
             Remove from Disk                           │
            (ACK via discard)                           ▼
                                                Process Restart / Replay
```

### Exact Storage Mechanics

1. **In-Memory Storage Structure:**
   - **Pre-Init:** `EventQueue` in [queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/queue.ts#L40-L41) stores events in JavaScript `Array` instances:
     ```ts
     private tiers: Record<EventPriority, QueueTier> // { critical: Event[], high: Event[], normal: Event[] }
     private retryQueue: Event[] = []
     ```
   - **Post-Init:** `TransportEventQueue` in [transport-event-queue.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-event-queue.ts#L34-L37) stores events in a fixed-size circular ring-buffer array:
     ```ts
     private buffer: (SDKEvent | undefined)[] = new Array<SDKEvent | undefined>(this.capacity)
     private head = 0
     private count = 0
     private criticalCount = 0
     ```

2. **Persistent Storage Structure:**
   - `PersistentStorage` in [persistent-storage.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L118-L144) stores events on the local filesystem as **Newline-Delimited JSON (NDJSON)**:
     ```text
     {"event":{...},"persistedAt":1728045600000}\n
     {"event":{...},"persistedAt":1728045601000}\n
     ```
   - Events are buffered in an in-memory `buffer: Event[] = []` and periodically flushed to disk using debounced asynchronous I/O.

3. **Fallback-Only Durability Policy:**
   - As documented in [persistent-storage.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L5-L21), the SDK intentionally avoids write-ahead persistence for every event. Persisting every event eagerly was identified in prior revisions as causing duplicate replays, billing inflation, and disk I/O bottlenecks. Disk persistence is strictly a **safety net** triggered upon network send failure or during process shutdown.

---

## 5. Storage Implementation & Disk Engine

### 5.1 Storage Identification

- **Storage Class:** `PersistentStorage` (Singleton: `persistentStorage = new PersistentStorage()`)
- **Source Location:** [src/storage/persistent-storage.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L110)
- **Export Surfaces:** [src/storage/persistent-storage.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L652), [src/internals.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/internals.ts#L73), [src/index.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L208)

### 5.2 Storage Paths & Files

The directory is resolved dynamically by [resolveDefaultDirectory()](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L619-L649):

| Operating System | Directory Resolution Path | Fallback Path |
|---|---|---|
| **Windows (`win32`)** | `%LOCALAPPDATA%\pulse-sdk\events` | `%TEMP%\pulse-sdk\events` |
| **macOS (`darwin`)** | `$HOME/Library/Caches/pulse-sdk/events` | `/tmp/pulse-sdk/events` |
| **Linux / POSIX** | `$XDG_CACHE_HOME/pulse-sdk/events` or `$HOME/.cache/pulse-sdk/events` | `/tmp/pulse-sdk/events` |

#### File Naming Conventions:
- **Active Data File:** `pulse-events[-<apiKeyHash:0-8>].ndjson`  
  *(where `<apiKeyHash>` is the first 8 hex characters of `sha256(apiKey)`)*
- **Compaction Temp File:** `pulse-events[-<apiKeyHash:0-8>].ndjson.tmp`
- **Rotated Archive File:** `pulse-events[-<apiKeyHash:0-8>].ndjson.<timestamp>.bak`

### 5.3 Serialization, File System Modes & Encodings

- **File Encoding:** `utf8`
- **File Permissions Mode:** `0o600` (Owner read/write only — prevents other local users from viewing telemetry/PII)
- **Directory Permissions Mode:** `0o700` (Owner read/write/execute only)
- **Record Serialization:** Single-line JSON representation:
  ```json
  {"event":{...},"persistedAt":1728045678901}
  ```

### 5.4 File Operations & Atomicity

```
                                  ┌──────────────────────────┐
                                  │      writeChain          │
                                  │ (Single-flight Promise)  │
                                  └─────────────┬────────────┘
                                                │
                 ┌──────────────────────────────┴──────────────────────────────┐
                 ▼                                                             ▼
     [flush() Append Path]                                       [discard() Compaction Path]
                 │                                                             │
                 ▼                                                             ▼
    appendFile(dataFile, content,                                writeFile(tempFile, content,
      { encoding: 'utf8', mode: 0o600 })                           { encoding: 'utf8', mode: 0o600 })
                 │                                                             │
                 │                                                             ▼
                 │                                                safeAtomicRename(tempFile, dataFile)
                 │                                                             │
                 │                                                             ▼
                 └──────────────────────────────┬──────────────────────────────┘
                                                ▼
                                   withIoTimeout(operation, 5000ms)
```

1. **Concurrency Control (`writeChain`):**
   Writes are serialized through a single promise chain in [persistent-storage.ts:L611-L617](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L611-L617):
   ```ts
   private enqueueWrite(operation: () => Promise<void>): Promise<void> {
     const timed = () => withIoTimeout(operation(), this.ioTimeoutMs, 'persistent-storage write')
     this.writeChain = this.writeChain.then(timed, timed)
     return this.writeChain
   }
   ```
   This prevents concurrent write interleaving or race conditions across async event-loop ticks.

2. **Atomic Compaction & Cleanup (`discard`):**
   When batches are confirmed delivered, `discard()` reads the file, filters out delivered `eventId`s, writes retained entries to `pulse-events.ndjson.tmp`, and renames the file using `safeAtomicRename`.

3. **Cross-Platform Atomic Rename (`safeAtomicRename`):**
   Windows NTFS locks files during indexing or antivirus scans (`EPERM`, `EBUSY`, `EACCES`). [safeAtomicRename](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L679-L703) handles this with up to 5 retries with exponential backoff, falling back to `copyFile` + `unlink` if rename fails.

4. **I/O Timeout Protection (`withIoTimeout`):**
   Every file operation is raced against a 5,000ms timer (`DEFAULT_IO_TIMEOUT_MS`) via `Promise.race()`. If an NFS mount or full disk hangs, the operation rejects and yields instead of hanging process shutdown.

---

## 6. Startup Recovery & Replay Pipeline

### 6.1 Startup Sequence Timeline

```
1. SDK init(options) called
   │
   ├─► Compute apiKeyHash = sha256(options.apiKey).hex
   ├─► persistentStorage.configure({ apiKeyHash })
   ├─► const persistedEventsPromise = persistentStorage.init()  <── (Starts disk I/O in parallel with CPU setup)
   │
2. Subsystem Initialization (Parallel with Disk Read)
   ├─► FeatureController, LimitsEngine, SecurityScrubber, EntitlementGate
   ├─► TransportRouter.initialize()
   ├─► Auto-instrumentations (Express, HTTP, MongoDB, etc.)
   ├─► Signal handlers registered (SIGTERM / SIGINT)
   │
3. Completion of Pre-Init Setup
   ├─► await waitForPendingInstrumentations()
   ├─► await payloadScrubberPromise
   │
4. Await Persisted Events & Replay
   ├─► const persistedEvents = await persistedEventsPromise
   ├─► client.markInitialized()  <── (Switches capture gate from buffering to active pipeline)
   ├─► filterBufferedEvents(config)  <── (Filters pre-init buffer against remote feature flags)
   │
5. Execute replayBufferedEvents(persistedEvents)
   ├─► Drain pre-init in-memory buffer: const buffered = eventQueue.drainAll()
   ├─► Combine: const events = [...persistedEvents, ...buffered]  <── (DISK EVENTS FIRST, THEN PRE-INIT)
   │
   └─► Loop through combined events:
         ├─ processEvent(event) ──► Re-injects into full normalization/sanitization/routing pipeline
         └─ Yield event loop every 100 events:
              if ((index + 1) % 100 === 0) await new Promise(resolve => setImmediate(resolve))
```

### Detailed Invariant Answers

- **Does startup inspect persistent storage?**  
  **Yes.** `persistentStorage.init()` is invoked during `init()` in [init.ts:L226](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts#L226).
- **Does it load pending events?**  
  **Yes.** `init()` calls `this.replay()`, reading all lines from `pulse-events[-<hash>].ndjson`.
- **Does it replay them automatically?**  
  **Yes.** Replay occurs automatically without requiring manual caller intervention.
- **When does replay happen?**  
  Replay is initiated *early* in `init()` to overlap I/O with CPU setup, but is awaited and injected *after* transport/subsystems are configured and *immediately after* `client.markInitialized()` is set.
- **Before or after SDK initialization?**  
  Replay reading begins *during* initialization; re-injection into transport happens at the final step of initialization before `init()` resolves.
- **Before or after instrumentation?**  
  After instrumentation is registered and pending async instrumentations have settled.
- **Is replay synchronous or asynchronous?**  
  **Asynchronous.** The file read is async (`fs/promises.readFile`), and processing yields every 100 events via `await setImmediate()`.
- **What happens if restoration fails?**  
  Failures are caught and logged at `warn` level; an empty array `[]` is returned. Initialization completes normally without crashing the application.
- **Are corrupt records discarded?**  
  **Yes.** In [persistent-storage.ts:L379-L382](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L379-L382), lines failing `JSON.parse` are silently skipped.
- **Are expired records discarded?**  
  **Yes.** Records where `now - entry.persistedAt > eventTtlMs` (default 24h) are dropped. The data file is rewritten cleanly to remove them.
- **Are duplicate records possible on replay?**  
  **Yes.** If an event was received by the ingestion server on a previous run but the connection dropped before the client received the HTTP 200 ACK, the event remained on disk and will be replayed. The backend **must** deduplicate by `eventId`.

---

## 7. Network Failure & Error Handling Sequence

When an HTTP transport request fails, the SDK executes the following deterministic control flow in [batch-manager.ts:L488-L570](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L488-L570):

```
HTTP Request Attempt (Batch of N events)
 │
 ├──► CASE A: HTTP Status >= 500, 429, or 408 (Retryable Response)
 │      ├─ 1. HealthMonitor.recordFailure(route)
 │      ├─ 2. Increment totalFailed += events.length
 │      ├─ 3. persistOnFailure(events, 'http_' + status)
 │      │       └─ Passes through PersistenceGovernor.
 │      │       └─ Survivable events saved to PersistentStorage buffer and scheduled to disk.
 │      ├─ 4. Parse 'Retry-After' header if present (supports seconds or HTTP dates)
 │      └─ 5. retryOrRetain(events, retryAfterMs)
 │
 ├──► CASE B: HTTP Status 4xx (excluding 429, 408) (Non-Retryable Client Error)
 │      ├─ 1. HealthMonitor.recordFailure(route)
 │      ├─ 2. Increment totalDropped += events.length
 │      ├─ 3. Delete eventIds from retryAttempts and firstAttemptTimestamps
 │      ├─ 4. Notify drop handler: onDrop({ route, reason: 'route_unavailable', count })
 │      └─ 5. NOT persisted. NOT retried. Event is permanently DROPPED.
 │
 └──► CASE C: Network Error / Timeout / Abort (Exception Thrown by fetch)
        ├─ 1. Normalize error via toError(error)
        ├─ 2. Check if AbortError (due to socketTimeoutMs or process shutdown)
        ├─ 3. HealthMonitor.recordFailure(route)
        ├─ 4. Increment totalFailed += events.length
        ├─ 5. persistOnFailure(events, 'network_error')
        │       └─ Passes through PersistenceGovernor.
        │       └─ Survivable events saved to PersistentStorage.
        └─ 6. retryOrRetain(events)
```

### Critical Implementation Details:
- **Is the batch returned to the queue?**  
  Yes. In `retryOrRetain()`, when the backoff timer fires, `this.options.queue.requeueFront(retryable)` prepends the events back into the route ring buffer.
- **Is it copied or mutated?**  
  The events array is sliced into a new `retryable: SDKEvent[]` array. The event objects themselves are **not** mutated; their original fields (`eventId`, `timestamp`, `metadata`) are preserved.
- **Can an event be lost between these operations?**  
  Only if a process crash occurs while events are in-flight in Node memory before `persistOnFailure` flushes to disk (a window bounded by `flushDebounceMs`, default 1s).

---

## 8. Error Classification Matrix

The SDK employs two error classification engines:
1. **Control-Plane Classifier:** `classifyError` in [retry-classifier.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/retry-classifier.ts#L15-L77) (governs SDK initialization, remote config fetch, background recovery).
2. **Data-Plane Classifier:** [batch-manager.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L488-L540) (governs telemetry batch ingestion).

### Authoritative Telemetry Error Matrix (Data Plane)

| Failure Scenario | Retry? | Persist to Disk? | Drop? | Requeue to Buffer? | Underlying Reason & Behavior |
|---|:---:|:---:|:---:|:---:|---|
| **Network Timeout (`AbortError`)** | **YES** | **YES** | NO | **YES** | Socket timeout (`timeoutMs`) fired; transient network stall. |
| **`ECONNRESET` / `ECONNREFUSED`** | **YES** | **YES** | NO | **YES** | TCP connection reset/refused; retryable system error. |
| **`ETIMEDOUT` / `ENOTFOUND`** | **YES** | **YES** | NO | **YES** | DNS failure or gateway timeout; transient system error. |
| **HTTP 400 (Bad Request)** | **NO** | **NO** | **YES** | **NO** | Malformed wire format or schema mismatch; retrying will never succeed. |
| **HTTP 401 (Unauthorized)** | **NO** | **NO** | **YES** | **NO** | Invalid or revoked API key; permanent auth failure. |
| **HTTP 403 (Forbidden)** | **NO** | **NO** | **YES** | **NO** | Missing permissions or project suspended; permanent auth failure. |
| **HTTP 404 (Not Found)** | **NO** | **NO** | **YES** | **NO** | Ingestion route URL does not exist; permanent endpoint failure. |
| **HTTP 408 (Request Timeout)** | **YES** | **YES** | NO | **YES** | Ingestion server timed out waiting for request; retryable. |
| **HTTP 429 (Too Many Requests)** | **YES** | **YES** | NO | **YES** | Rate limited; inspects `Retry-After` header and backs off. |
| **HTTP 500 (Internal Server Error)**| **YES** | **YES** | NO | **YES** | Ingestion backend crash; transient failure. |
| **HTTP 502 (Bad Gateway)** | **YES** | **YES** | NO | **YES** | Reverse proxy or load balancer gateway error; transient failure. |
| **HTTP 503 (Service Unavailable)** | **YES** | **YES** | NO | **YES** | Ingestion backend overloaded/maintenance; transient failure. |
| **HTTP 504 (Gateway Timeout)** | **YES** | **YES** | NO | **YES** | Upstream ingestion proxy timed out; transient failure. |
| **Payload > 4MB (`tooLarge`)** | **NO** | **NO** | **YES\*** | **YES\*** | If single event: dropped. If multi-event: bisected and halves requeued. |
| **Batch Retention > 5 Minutes** | **NO** | **NO** | **YES** | **NO** | Dropped by `retryOrRetain` to prevent memory poisoning. |
| **Retries Exceeded (`> maxRetries`)**| **NO** | **NO** | **YES** | **NO** | Dropped from memory retry loop; remains on disk if already persisted. |

---

## 9. Retry Mechanism & Backoff Engine

The retry algorithm is implemented in `BatchManager` ([batch-manager.ts:L572-L658](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L572-L658)) and [retryDelay:L800-L815](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L800-L815).

### 9.1 Retry State Tracking
- **Attempt Tracking:** `retryAttempts: Map<string, number>` keyed by `eventId`.
- **Age Tracking:** `firstAttemptTimestamps: Map<string, number>` keyed by `eventId`.
- **Retention Guard:** If `Date.now() - firstAttemptTimestamp > 300_000` (5 minutes), the batch is marked stale and dropped immediately.

### 9.2 Backoff Calculation Formula

```ts
function retryDelay(config: TransportRetryConfig, attempt: number, retryAfterMs?: number | null): number {
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(60_000, retryAfterMs)
  }
  const base = Math.max(0, config.baseDelayMs)
  let delay = base
  if (config.backoff === 'fixed') {
    delay = base
  } else if (config.backoff === 'linear') {
    delay = Math.min(30_000, base * attempt)
  } else {
    // Exponential default: base * 2^(attempt - 1)
    delay = Math.min(30_000, base * 2 ** Math.max(0, attempt - 1))
  }
  // Full random jitter between 80% and 120%
  const jitter = 0.8 + Math.random() * 0.4
  return Math.max(50, Math.floor(delay * jitter))
}
```

### 9.3 Default Timing Table (Assuming `baseDelayMs: 500` & Exponential Backoff)

| Attempt Number | Raw Calculated Delay | Delay with Jitter (0.8x – 1.2x) | Max Ceiling Applied |
|---|---|---|---|
| **Attempt 1** | $500 \times 2^0 = 500\text{ ms}$ | $400\text{ ms} - 600\text{ ms}$ | $30,000\text{ ms}$ |
| **Attempt 2** | $500 \times 2^1 = 1,000\text{ ms}$ | $800\text{ ms} - 1,200\text{ ms}$ | $30,000\text{ ms}$ |
| **Attempt 3** | $500 \times 2^2 = 2,000\text{ ms}$ | $1,600\text{ ms} - 2,400\text{ ms}$ | $30,000\text{ ms}$ |
| **Attempt 4+** | Drops if `maxRetries: 3` | — | — |

### 9.4 Retry Cancellation & Cleanup
- Delayed retries are tracked in `pendingRetryTimers: Map<Timeout, { events, resolve }>`.
- When `shutdown()` or `cancelPendingRetries()` is called, all pending timers are cleared with `clearTimeout()`, and the un-sent events are synchronously requeued to the front of the queue so they are flushed or persisted.

---

## 10. Queue Limits & Capacity Ceilings

The SDK defines strict safety bounds enforced at configuration and runtime:

| Limit Parameter | Default Value | Config Key | Enforcement Location | Behavior When Limit Exceeded |
|---|---|---|---|---|
| **Route Queue Capacity** | `10,000` events | `transport.queue.maxSize` | [transport-event-queue.ts:L82](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-event-queue.ts#L82) | Drops oldest non-critical event (`drop_oldest`) or drops incoming event (`drop_newest`). |
| **Critical Slot Reserve** | `100` slots | `transport.queue.criticalReserve` | [transport-event-queue.ts:L68](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-event-queue.ts#L68) | Ordinary telemetry cannot enter once queue reaches `capacity - reserve`. |
| **Pre-Init Queue Capacity** | `100,000` events | `limits.maxQueueSize` | [queue.ts:L47](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/queue.ts#L47) | Sheds normal/high tier events; rejects incoming if critical tier is full. |
| **In-Flight Pipelines Cap** | `10,000` tasks | `MAX_PENDING_PIPELINES` | [event-pipeline.ts:L89](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/event-pipeline.ts#L89) | Rejects incoming event synchronously with `pipeline_overloaded`. |
| **Max Payload Size** | `4,194,304` bytes (4MB) | `limits.maxPayloadSize` | [batch-manager.ts:L267](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L267) | Bisects batch into two halves; drops single event if single event > 4MB. |
| **Max Disk Events** | `10,000` events | `offlineQueue.maxEvents` | [persistent-storage.ts:L187](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L187) | Triggers on-disk log rotation (`pulse-events.ndjson.<ts>.bak`). |
| **Max Disk File Size** | `10,485,760` bytes (10MB)| `offlineQueue.maxFileSizeBytes`| [persistent-storage.ts:L556](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L556) | Triggers on-disk log rotation. |
| **Event Disk TTL** | `86,400,000` ms (24 hours)| `offlineQueue.eventTtlMs` | [persistent-storage.ts:L373](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L373) | Dropped during startup `replay()`; file rewritten. |
| **Max Memory Limit** | `256` MB (up to 1GB ceiling)| `limits.maxMemoryMb` | [memory-detector.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/memory-detector.ts) | Triggers `CRITICAL` adaptive pressure, activating load shedding. |
| **Max Retries** | `3` attempts | `transport.retry.maxRetries` | [batch-manager.ts:L612](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L612) | Aborts memory retries; drops event from retry loop. |
| **Max Batch Retention Age** | `300,000` ms (5 mins) | `MAX_BATCH_RETENTION_AGE_MS` | [batch-manager.ts:L597](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L597) | Dropped to prevent stale memory poisoning. |
| **Max Persist Per Minute** | `20,000` (or `100,000`) | `persistenceGovernance.maxPersistPerMinute` | [persistence-governor.ts:L129](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistence-governor.ts#L129) | Skips non-critical disk persistence when budget exceeded. |

---

## 11. What Happens When the Queue is Full?

### 11.1 Post-Init Route Queue (`TransportEventQueue`)
When `TransportEventQueue.enqueue(event)` is called and the queue is full:
1. **Critical Reservation Check:**
   If the incoming event is **non-critical** (`isCritical(event) === false`), it is not allowed to use the last `criticalReserve` slots (default 100 slots).
   - If `ordinaryCount >= ordinaryCapacity`:
     - If `overflowStrategy === 'drop_oldest'`: Scans the ring buffer for the **oldest non-critical event** via `findOldestNonCritical()`. If found, that event is evicted, the new event is appended, and `notifyDrop(evicted)` is fired.
     - If no non-critical event exists or strategy is `drop_newest`: The incoming event is dropped immediately and `notifyDrop(event)` is fired.
2. **Hard Capacity Check (`count >= capacity`):**
   - If the incoming event is **critical** (fatal error, fatal log, or failed cron check-in): It searches for the oldest non-critical event in the buffer and evicts it to guarantee room for the critical event.
   - If all items in the queue are critical, or `overflowStrategy === 'drop_newest'`, the incoming event is dropped.

### 11.2 Pre-Init Queue (`EventQueue`)
When `EventQueue.add(event)` is called pre-init:
- The queue is partitioned: Critical tier (40%), High tier (40%), Normal tier (20%).
- If a tier is full:
  - Critical tier attempts to make room by shedding an event from the `high` tier (or `normal` tier).
  - High tier attempts to make room by shedding an event from the `normal` tier.
  - Normal tier drops immediately.
  - Producers are **never blocked** (no async backpressure or thread blocking); events are dropped and drop handlers are notified.

---

## 12. Persistence Failure & Fault Tolerance

The SDK is strictly engineered **never to crash the host application** due to a storage failure:

| Failure Scenario | SDK Reaction & Handling | Impact on Host Application |
|---|---|---|
| **Permission Denied (`EACCES`/`EPERM`)** | Caught in `init()`, logs warning, disables disk persistence for the session. | Zero crash impact; application runs normally in-memory. |
| **Disk Full (`ENOSPC`)** | `appendFile` or `writeFile` rejects; caught in `flush()`; increments `writeErrors`. | Zero crash impact; events dropped from disk buffer. |
| **Directory Missing** | `mkdir(directory, { recursive: true, mode: 0o700 })` auto-creates parent tree. | Transparent self-healing. |
| **Corrupted NDJSON File** | `replay()` parses line-by-line in try/catch; corrupt lines discarded. | Valid lines replayed; file compacted cleanly. |
| **Read Failure / Frozen NFS** | Bounded by `withIoTimeout(5000ms)`; rejects cleanly after 5s. | Prevents process shutdown from hanging indefinitely. |
| **Repeated Write Errors** | In [persistent-storage.ts:L273-L278](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L273-L278): if `writeErrors >= 10`, `this.initialized = false`. | Storage auto-disables; ceases further disk I/O attempts. |
| **JSON Serialization Error** | Caught in chunked stringify loop; logged at debug/warn. | Single corrupt event dropped; remaining buffer written. |

---

## 13. Serialization Engine & Payload Bisection

### 13.1 Two Distinct Serialization Formats

```
           ┌────────────────────────────────────────────────────────┐
           │                     EVENT OBJECT                       │
           └──────────────┬──────────────────────────┬──────────────┘
                          │                          │
                 [For Disk Storage]          [For HTTP Transport]
                          │                          │
                          ▼                          ▼
               NDJSON Serialization       SerializationPool (Worker Threads)
             (Single-line JSON entry)       (JSON Payload + Gzip Buffer)
                          │                          │
                          ▼                          ▼
               {"event":{...},"persistedAt":...}\n     POST body: gzip compressed Buffer
```

1. **Disk Serialization:**
   - Format: Single-line JSON wrapped in `{ event, persistedAt }` followed by `\n`.
   - Chunking: `FLUSH_STRINGIFY_CHUNK_SIZE = 200`. Yields to event loop via `setImmediate` every 200 events so large flushes do not cause event-loop lag.

2. **Wire/Transport Serialization:**
   - Format: `{ events: safeBatch, route, timestamp: Date.now() }`.
   - Offloaded to a dedicated Node.js `worker_threads` pool (`SerializationPool` with 2 workers) in [serialization-pool.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-pool.ts#L41-L54).
   - If workers fail or queue exceeds 64 pending requests, seamlessly falls back to main-thread `safeJsonStringify()`.

### 13.2 Payload Bisection for Oversized Batches (`tooLarge`)

In [batch-manager.ts:L267-L301](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L267-L301):
- If the serialized payload exceeds `maxPayloadBytes` (default 4MB):
  - If `events.length === 1`: The event is un-sendable; it is dropped and `onDrop({ reason: 'event_too_large' })` is emitted.
  - If `events.length > 1`: The batch is automatically bisected:
    ```ts
    const half = Math.max(1, Math.floor(events.length / 2))
    const firstHalf = events.slice(0, half)
    const secondHalf = events.slice(half)
    this.options.queue.requeueFront(secondHalf) // Prepend back to queue
    this.sendBatch({ events: firstHalf })       // Send first half immediately
    ```

---

## 14. Compression Pipeline & Disk Interaction

### 14.1 Compression Order of Execution

Compression occurs **late** in the delivery pipeline:

$$\text{Event Captured} \longrightarrow \text{Pipeline} \longrightarrow \text{Queue (Uncompressed)} \longrightarrow \text{Batch (Uncompressed)} \longrightarrow \text{JSON Stringify} \longrightarrow \mathbf{gzip} \longrightarrow \text{HTTP POST}$$

Compression does **NOT** occur before queueing. Events reside in memory and on disk as standard uncompressed JavaScript objects / UTF-8 JSON.

### 14.2 Is Persisted Data on Disk Compressed?

**NO.** Persisted data on disk (`pulse-events.ndjson`) is plain-text UTF-8 NDJSON. It is **not** gzip-compressed. This design allows:
- Fast append operations without re-compressing streams.
- Zero-overhead crash inspection and debugging via standard CLI tools (`grep`, `tail`, `jq`).
- Atomic line-by-line filtering during ACK compaction (`discard()`).

---

## 15. Delivery Semantics & Duplicate Analysis

### 15.1 Formal Delivery Guarantee: **At-Least-Once**

The SDK guarantees **at-least-once delivery**. It does **not** provide exactly-once delivery across network partitions.

### 15.2 Duplicate Delivery Simulation

```
Client (SDK)                                          Backend Server
    │                                                       │
    ├─────────── HTTP POST (Batch [Event A]) ──────────────►│ (Server receives batch)
    │                                                       ├─ Writes to DB
    │                                                       ├─ Commits transaction
    │                                                       └─ Generates HTTP 200 OK
    │                                                               │
    │ ◄- - - - - [TCP RST / Network Dropped / Timeout] - - - - - - -┤ (Response Lost!)
    │
[Client times out or observes socket error]
    ├─ Cannot know server committed batch
    ├─ Treats send as failed
    ├─ Calls persistOnFailure()
    └─ Retries sendBatch() or replays on next reboot
    │
    ├─────────── HTTP POST (Retry [Event A]) ──────────────►│ (Duplicate delivered!)
```

### 15.3 Deduplication Mechanisms
- **Cryptographic Event IDs:** Every event is stamped at capture with a cryptographically-random UUIDv4 `eventId` in [event-pipeline.ts:L119](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/event-pipeline.ts#L119).
- **ID Preservation:** The `eventId` is strictly preserved across memory buffers, disk NDJSON lines, retry attempts, and startup replays.
- **Server-Side Deduplication Requirement:** As explicitly stated in [persistent-storage.ts:L49-L53](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L49-L53):
  > *"The backend MUST dedupe by `eventId` to guarantee exactly-once. Every event in this SDK has a cryptographically-random UUIDv4 `eventId` that is preserved across persistence, retries, and replays."*

---

## 16. Comprehensive Event Loss Audit

| Pipeline Stage | Can Lose Events? | Exact Condition / Trigger | Intentional / By Design? |
|---|:---:|---|:---:|
| **Shutdown Gate** | **YES** | New events captured while `isSDKShuttingDown()` or `pipelineDraining` is true (fatal crash telemetry exempt). | **YES** (Prevents leaks during drain). |
| **Feature / Entitlement**| **YES** | Remote config disables feature (`features.errors = false`) or entitlement denied. | **YES** (Remote control policy). |
| **Sampling Engine** | **YES** | Event rejected by head-based or adaptive sampling (`isSampled() === false`). | **YES** (Volume control). |
| **Tenant / Quota Gate** | **YES** | Tenant hourly quota exhausted or billable quota reached. | **YES** (Cost/quota protection). |
| **Load Shedder** | **YES** | High system pressure causes P3 shed or P2 group-level drop. | **YES** (Host CPU/RAM protection). |
| **Pre-Init Buffer** | **YES** | Pre-init burst exceeds `maxQueueSize` (100,000) and sheds normal/high events. | **YES** (Memory safety ceiling). |
| **Pipeline Capacity** | **YES** | Concurrent in-flight pipeline tasks exceed `MAX_PENDING_PIPELINES` (10,000). | **YES** (Event loop saturation protection). |
| **Route Ring Buffer** | **YES** | Route queue reaches `maxSize` (10,000); oldest non-critical event evicted. | **YES** (Drop-oldest ring buffer policy). |
| **Serialization** | **YES** | Single event exceeds `maxPayloadBytes` (4MB) or has un-stringifiable cyclic data. | **YES** (Poison pill protection). |
| **Send Retries** | **YES** | Network outage lasts longer than `maxRetries` (3 attempts). | **NO** (Retained on disk if persisted). |
| **Batch Retention** | **YES** | Batch age in memory exceeds `MAX_BATCH_RETENTION_AGE_MS` (5 minutes). | **YES** (Stale memory cleanup). |
| **Persistence Governor**| **YES** | Non-critical event under high pressure or per-minute persist budget exceeded. | **YES** (Disk I/O protection). |
| **Disk TTL Expiration** | **YES** | Event resides on disk longer than `eventTtlMs` (24 hours) before process restarts. | **YES** (Telemetry obsolescence). |
| **Hard Crash / SIGKILL**| **YES** | `kill -9` or kernel panic before debounced flush writes to disk (window: <1s). | **NO** (Unavoidable OS-level loss). |

---

## 17. Graceful Shutdown & Signal Orchestration

### 17.1 Shutdown Sequence ([lifecycle.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts#L391-L528))

Graceful shutdown executes a 14-step reverse-dependency (LIFO) orchestration with hard timeouts:

```
Process SIGTERM / SIGINT / SDK.shutdown()
  │
  ├─ 1. Run onBeforeShutdown hooks (timeout: 5000ms)
  ├─ 2. Stop accepting new events: eventQueue.setShuttingDown(true)
  ├─ 3. Pre-teardown flush of internal metrics (metricsRegistry.flush(true))
  ├─ 4. FeatureController.teardownAll() & flushTracer() (flush finished spans to transport)
  ├─ 5. drainPendingEventProcessing() (await all deferred setImmediate pipelines)
  ├─ 6. Final metrics flush and otelMetrics.shutdown()
  ├─ 7. TransportRouter.flushAll() (wait for in-flight HTTP requests and retries)
  ├─ 8. teardownPlugins()
  ├─ 9. shutdownTracer() (release OTel providers)
  ├─ 10. Reset subsystems (Cron, Profiling, Logging, Session)
  ├─ 11. Reset global error handlers & remove process listeners
  ├─ 12. Stop deduplicator timers
  │
  ├─ 13. Step 13: DRAIN RESIDUAL EVENTS TO DISK:
  │      ├─ router.shutdown() ──► Aborts active requests, quiesces retry timers, collects residual SDKEvent[]
  │      ├─ persistentStorage.persistBatch(residual) ──► Writes undelivered transport events to disk!
  │      ├─ eventQueue.drainAll() ──► Collects remaining pre-init events
  │      ├─ persistentStorage.persist(legacyEvents)
  │      └─ await persistentStorage.flush() ──► Immediate flush to NDJSON file!
  │
  ├─ 14. Step 14: persistentStorage.shutdown()
  │      ├─ Sets initialized = false (rejects new persist calls)
  │      ├─ Awaits active writeChain
  │      └─ Releases file handles
  │
  └─ 15. Unconditional Cleanup (resets all singletons, guarantees clean reinit)
```

### 17.2 Watchdog & Process Exit Guarantees
- **Watchdog Timer:** On `SIGTERM`/`SIGINT`, a hard 5,000ms watchdog timer (`watchdogTimer.unref()`) is armed. If shutdown deadlocks, the watchdog forces `process.exit(128 + signal)`.
- **Clean Exit:** If the SDK was the sole listener on `SIGTERM`/`SIGINT`, Node.js will not exit on its own; the SDK explicitly calls `process.exit(exitCode)` once shutdown completes.

---

## 18. Serverless & Ephemeral Runtimes Analysis

### Compatibility Evaluation (AWS Lambda, Vercel, GCP, Azure Functions)

| Architectural Assumption | Behavior in Serverless / Lambda | Risk Level | Mitigation / Required Pattern |
|---|---|:---:|---|
| **Process Lifetime** | Lambda containers freeze CPU immediately when the invocation handler returns. | **HIGH** | User **must** invoke `await pulse.flush()` before returning response. |
| **Background Timers** | `setTimeout().unref()` timers freeze when container freezes; will not tick until next invocation. | **HIGH** | Do not rely on background flush intervals in serverless. |
| **Filesystem Persistence** | `/tmp` is ephemeral and shared only across warm invocations of the same container instance. | **MEDIUM** | Persisted events survive warm container re-use, but are lost when container is destroyed. |
| **Startup Replay** | Replay occurs during cold-start `init()`. Extends cold-start latency if disk file is large. | **MEDIUM** | Disk file is kept small (bounded by `maxEvents: 10,000`); I/O runs in parallel with setup. |
| **Worker Threads** | `SerializationPool` creates 2 `worker_threads`. Some restricted environments disallow workers. | **LOW** | Auto-detects worker errors and seamlessly falls back to main-thread serialization. |
| **Process Signals** | Serverless platforms do not send standard `SIGTERM` before freezing/destroying micro-VMs. | **MEDIUM** | Graceful shutdown does not run on Lambda freeze; explicit `flush()` is mandatory. |

---

## 19. Concurrency & Thread Safety

| Concurrency Vector | Threat / Race Condition | Architectural Protection in Code |
|---|---|---|
| **Concurrent `enqueueEvent`** | Multiple requests capturing events simultaneously. | `setImmediate` defers work; `TransportEventQueue` uses thread-safe single-threaded event loop array operations. |
| **Concurrent Batch Sends** | Multiple batches firing HTTP requests simultaneously. | `ConnectionManager` enforces strict Semaphore limits (global max: 50, per-route limits: 5–20). |
| **Concurrent Disk Persists** | Multiple failed batches attempting simultaneous file writes. | `PersistentStorage.writeChain` chains all writes onto a single promise sequence. |
| **Concurrent Shutdown Calls** | Multiple callers or signals invoking `shutdown()`. | `SingleFlight` pattern: second caller joins existing `shutdownPromise`. |
| **Shutdown vs. Active Ingestion**| New events arriving while shutdown is draining. | `isSDKShuttingDown()` and `eventQueue.setShuttingDown(true)` synchronously reject new events. |
| **Reconfiguration Race** | Remote config update arriving during active flush. | `TransportRouter.updateTransport()` uses build-then-swap: new runtime constructed completely before reference swap. |

---

## 20. Memory Pressure & Load Shedding

The SDK integrates a 5-state adaptive pressure monitor (`adaptivePressure`) in [adaptive-pressure.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/adaptive-pressure.ts) and [load-shedder.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/load-shedder.ts):

```
                                  ┌──────────────────────────┐
                                  │ AdaptivePressureMonitor  │
                                  │ (V8 Heap + Lag + Queues) │
                                  └─────────────┬────────────┘
                                                │
                 ┌──────────────┬───────────────┼───────────────┬──────────────┐
                 ▼              ▼               ▼               ▼              ▼
              HEALTHY        ELEVATED       PRESSURED        CRITICAL      RECOVERING
              (Score < 30)   (30-50)         (50-75)         (Score > 75)   (Post-Crit)
                 │              │               │               │              │
P0 (Fatal)       Keep           Keep            Keep            Keep           Keep
P1 (Errors)      Keep           Keep            Keep            Keep           Keep
P2 (Requests)    Keep           Keep            Keep            10% Sample     Keep
P3 (Metrics/Log) Keep           Keep            100% Shed       100% Shed      100% Shed
```

- **Correlation-Group Preservation:** Under pressure, spans and requests correlated with an error/crash (`groupTracker.hasError(groupKey)`) are automatically **promoted to P1** so that diagnostic error context is never shed.
- **OOM Prevention:** Hard capacities on `TransportEventQueue` (10,000), `pendingPipelines` (10,000), and `ConnectionManager` prevent unbounded queue growth during prolonged network outages.

---

## 21. Priority Tiers & Invariant Protection

The SDK implements 4 distinct, coordinated priority taxonomies:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. Ingestion Admission (LoadShedder)                                                          │
│    p0_critical (Fatal/Crash) > p1_error (Errors/Context) > p2_request (Spans) > p3_low (Logs)  │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. Pre-Init Buffer (EventQueue)                                                                │
│    critical (40% capacity) > high (40% capacity) > normal (20% capacity)                       │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. Post-Init Wire Routes (RouteRegistry / TransportRouter)                                     │
│    critical (errors) > high (requests/traces/crons) > normal (metrics/logs) > low (profiles)   │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 4. Disk Durability (PersistenceGovernor)                                                       │
│    critical (100% Persist) > important (Normal/Elevated Persist) > transient (Normal Only)     │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Inviolable Invariant:** Under zero circumstances are `critical` / `p0_critical` events shed or denied persistence unless physical hardware exhaustion (disk full + RAM exhausted) occurs.

---

## 22. Event Loop, Timers & Worker Threads

### 22.1 Event Loop Unref Strategy
To prevent the SDK from preventing the Node.js process from exiting cleanly, **every recurring and delayed timer in the transport and queue layers calls `.unref()`**:
- `BatchManager.timer`: [batch-manager.ts:L739](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L739) (`this.timer.unref?.()`)
- `BatchManager.retryTimer`: [batch-manager.ts:L646](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L646) (`timer.unref?.()`)
- `PersistentStorage.flushTimer`: [persistent-storage.ts:L539](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts#L539) (`this.flushTimer.unref()`)
- `RecoveryWorker.timer`: [recovery-worker.ts:L137](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/recovery-worker.ts#L137) (`this.timer.unref?.()`)
- `WatchdogTimers`: [lifecycle.ts:L260](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts#L260) (`watchdogTimer.unref?.()`)

### 22.2 Worker Threads
- Handled by `SerializationPool` ([serialization-pool.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-pool.ts)).
- Spawns 2 persistent worker threads running [serialization-worker.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/serialization-worker.ts).
- Terminated cleanly during `TransportRouter.shutdown()` via `SerializationPool.reset()`.

---

## 23. Observability, Introspection & Metrics

Developers and operators can observe the offline queue and transport system through the following mechanisms:

1. **Public Diagnostics API (`pulse.getDebugState()`):**
   ```ts
   import { pulse } from '@pulse/nodejs'
   const stats = pulse.getDebugState()
   // Returns: inFlightSends, queuedEvents, batchedEvents, droppedEvents
   ```
2. **Persistent Storage Counters (`persistentStorage.getStats()`):**
   - `totalPersisted`: Lifetime count of events written to disk.
   - `totalDiscarded`: Lifetime count of events ACKed and removed from disk.
   - `totalReplayed`: Count of events restored on startup.
   - `totalExpired`: Count of events discarded due to TTL expiry.
   - `replayCount`: Number of process restarts that discovered pending disk events.
   - `fileSizeBytes`: Current on-disk size of `pulse-events.ndjson`.
3. **Queue Drop Callbacks (`onDrop`):**
   Subscribed by `TransportRouter`, recording structured drop information:
   ```ts
   interface QueueDropInfo {
     route: EnterpriseRoute
     reason: 'queue_full' | 'event_too_large' | 'serialization_failed' | 'route_unavailable'
     count: number
     eventType?: string
     eventId?: string
     critical?: boolean
   }
   ```
4. **Console Debug Flags:**
   - Setting `process.env.PULSE_TRANSPORT_CONSOLE = 'true'` logs all wire requests/responses.
   - Setting `debug: true` in `init()` enables verbose internal logging via `getLogger()`.

---

## 24. Configuration Reference & Safety Ceilings

### 24.1 Remote Configuration Schema

```ts
export interface OfflineQueueConfig {
  readonly enabled: boolean           // Default: true
  readonly maxFileSizeBytes: number   // Default: 10,485,760 (10MB)
  readonly maxEvents: number          // Default: 10,000
  readonly eventTtlMs: number         // Default: 86,400,000 (24h)
  readonly ioTimeoutMs: number        // Default: 5,000 (5s)
  readonly flushDebounceMs?: number   // Default: 1,000 (1s)
}

export interface TransportRemoteConfig {
  readonly retry: {
    readonly enabled: boolean         // Default: true
    readonly maxRetries: number       // Default: 3
    readonly backoff: 'exponential' | 'linear' | 'fixed' // Default: 'exponential'
    readonly baseDelayMs: number      // Default: 500
  }
  readonly queue: {
    readonly overflowStrategy: 'drop_oldest' | 'drop_newest' // Default: 'drop_oldest'
    readonly maxSize: number          // Default: 10,000
    readonly criticalReserve: number  // Default: 100
  }
  readonly connections: {
    readonly maxTotalConnections: number // Default: 50
    readonly maxConnectionsPerRoute: Record<EnterpriseRoute, number>
    readonly acquireTimeoutMs: number // Default: 5,000
  }
}
```

### 24.2 Safety Ceilings ([limits.ts](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/constants/limits.ts#L6-L80))

| Setting | Minimum Allowed | Maximum Allowed (Ceiling) | Hard Ceiling Violation Effect |
|---|---|---|---|
| `offlineQueue.maxFileSizeBytes` | `1,024` (1 KB) | `104,857,600` (100 MB) | Snapshot rejected; previous config retained |
| `offlineQueue.maxEvents` | `1` | `100,000` | Snapshot rejected |
| `offlineQueue.eventTtlMs` | `60,000` (1 min) | `604,800,000` (7 days) | Snapshot rejected |
| `offlineQueue.ioTimeoutMs` | `500` (500 ms) | `60,000` (60 s) | Snapshot rejected |
| `transport.queue.maxSize` | `1` | `100,000` | Snapshot rejected |
| `transport.retry.maxRetries` | `0` | `10` | Snapshot rejected |
| `transport.retry.baseDelayMs` | `0` | `30,000` (30 s) | Snapshot rejected |

---

## Summary Verdict

The offline queue in the Node.js SDK is an **enterprise-grade, hybrid memory-first fallback system**. It deliberately rejects naive "write-ahead-log for every event" models to protect host application throughput and prevent duplicate billing, instead employing:
1. **Bounded in-memory ring buffers** for sub-millisecond event capture.
2. **Deterministic load shedding & priority preservation** to safeguard application execution.
3. **Fallback disk persistence** on network failure or shutdown with at-least-once delivery semantics.
4. **Resilient startup replay** that safely reconciles unconfirmed telemetry.
