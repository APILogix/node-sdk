# Master Plan: Enterprise Offline Queue & Storage Resilience Architecture

## 1. Executive Summary & Objective

This document defines the high-level enterprise architecture, design contracts, and implementation plan for the **Offline Queue and Telemetry Persistence System** in the Pulse Node.js SDK (`pulse-apm-node` / `sdk-node`).

### The Core Problem
1. **Long-Running Backend Services** (Docker, Kubernetes, Bare Metal, Express, NestJS, Fastify):
   - Telemetry must survive transient network outages, backend restarts, and graceful shutdowns.
   - Undelivered events must be durably queued to disk and replayed on startup without causing event duplication storms, CPU stalls, or unbounded disk growth.
2. **Serverless & Read-Only Environments** (AWS Lambda, Google Cloud Functions, Azure Functions, Cloud Run, Vercel, and Kubernetes pods with `readOnlyRootFilesystem: true`):
   - In serverless environments, file systems are strictly read-only except for `/tmp`.
   - Resolving directories to `$HOME` (e.g. `/var/task`, `/root`, `/workspace`) causes fatal `EROFS: read-only file system` or `EACCES: permission denied` errors.
   - When a serverless function invocation finishes, the container CPU freezes immediately. Asynchronous background timers (`setTimeout().unref()`) are suspended, causing queued events to freeze in memory without transmission unless explicitly flushed before invocation exit.
3. **Current Gaps in the SDK**:
   - `PersistentStorage.init()` leaves `this.initialized = true` even when `ensureDirectory()` fails with an error, leading to cascading write errors during runtime.
   - `resolveDefaultDirectory()` uses `$HOME` on Linux without checking for serverless environments (`AWS_LAMBDA_FUNCTION_NAME`, `K_SERVICE`, `VERCEL`, etc.) or read-only filesystems.
   - `config.offlineQueue` from remote config is not propagated to `PersistentStorage.configure()`.
   - Users cannot configure or disable `offlineQueue` via `pulse.init({ offlineQueue: false })` because `sdkInitOptionsSchema` has `.strict()` and omits `offlineQueue`.
   - Dynamic remote config updates (`ConfigDiffer` / `ConfigApplier`) ignore `offlineQueue` changes at runtime.
   - No built-in serverless wrapper exists to guarantee synchronous telemetry flush before container freeze.

---

## 2. Enterprise System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   APPLICATION / WORKLOAD LAYER                                  │
│                                                                                                 │
│    Long-Running Service (Express / Fastify)               Serverless Function (AWS Lambda / GC) │
│    pulse.init({ offlineQueue: { ... } })                 handler = pulse.wrapHandler(fn)        │
└──────────────────────────────────────┬──────────────────────────────────┬───────────────────────┘
                                       │                                  │
                                       ▼                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       PULSE CORE RUNTIME                                        │
│                                                                                                 │
│  ┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐    │
│  │   Capture Subsystems    │     │   Event Pipeline        │     │   Limits & Governance   │    │
│  │ (Traces, Errors, Metrics)│───► │ (Scrubbing, Dedupe)     │───► │ (Persistence Governor)  │    │
│  └─────────────────────────┘     └─────────────────────────┘     └────────────┬────────────┘    │
└───────────────────────────────────────────────────────────────────────────────┼─────────────────┘
                                                                                │
                                                                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    TRANSPORT & QUEUING LAYER                                    │
│                                                                                                 │
│               ┌────────────────────────────────────────────────────────┐                        │
│               │                      BatchManager                      │                        │
│               │  In-Memory Natural Batching (1s–10s buffer window)     │                        │
│               └───────────────────────────┬────────────────────────────┘                        │
│                                           │                                                     │
│                           ┌───────────────┴───────────────┐                                     │
│                           ▼                               ▼                                     │
│                  HTTP Transport Send              Send Failure / Shutdown                       │
│                   (/v1/traces, etc.)                              │                                     │
│                           │                                       ▼                                     │
│             ┌─────────────┴─────────────┐         ┌───────────────────────────────┐             │
│             ▼                           ▼         │       Storage Gatekeeper      │             │
│          2xx OK                      4xx/5xx      │  - Enabled?                   │             │
│             │                           │         │  - Serverless detected?       │             │
│             ▼                           │         │  - Filesystem writable?       │             │
│    persistentStorage.discard()          │         └───────────────┬───────────────┘             │
│    (Removes from disk if persisted)     │                         │                             │
│                                         ▼                         ▼                             │
│                           ┌──────────────────────────┐   ┌─────────────────┐                    │
│                           │  In-Memory Retry Backoff │   │ PersistentQueue │ (Degrades to       │
│                           │  (Quota & 429 Controller)│   │ (NDJSON /tmp)   │  No-Op if ROFS)    │
│                           └──────────────────────────┘   └─────────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. High-Level Architecture Components

### 3.1. Dual-Mode Storage Architecture
1. **Serverless Mode (Auto-Detected or Explicit)**:
   - Triggered when `AWS_LAMBDA_FUNCTION_NAME`, `K_SERVICE`, `FUNCTIONS_WORKER_RUNTIME`, or `VERCEL` is present, or when configured.
   - Default directory automatically targets `join(tmpdir(), 'pulse-sdk', 'events')` (which is mapped to `/tmp` in Lambda/Vercel/Cloud Run).
   - If `/tmp` is inaccessible or `readOnlyRootFilesystem: true` is enforced with no writable mount, gracefully auto-degrades to **pure in-memory mode** without throwing or emitting alarms.
2. **Server Mode (Long-Running Host / Container)**:
   - Resolves to OS cache / local app data directory (`LOCALAPPDATA` on Windows, `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux with `/tmp` fallback).
   - Probes write capability on startup. If unwritable, falls back to `tmpdir()`. If `tmpdir()` is unwritable, gracefully disables disk persistence.

### 3.2. Serverless Execution Lifecycle & `wrapHandler`
- In serverless architectures, background timers cannot flush telemetry after the handler finishes because the hypervisor suspends CPU cycles.
- The SDK provides `pulse.wrapHandler(fn, options?)`:
  - Enforces `context.callbackWaitsForEmptyEventLoop = false` so lingering sockets/keep-alive agents do not hold the Lambda execution open.
  - Intercepts invocation errors, captures them via `pulse.captureException(err)`, flushes pending telemetry within a configurable deadline (default 1500ms), and rethrows the error cleanly.
  - On normal return, invokes `await pulse.flush(timeoutMs)` to guarantee all traces, spans, and metrics reach the backend before execution freeze.

### 3.3. Zero-Bug Guarantee & Fault-Tolerant State Machine
1. **Initialized Flag Safety**:
   - `this.initialized` is set to `true` **only after** `ensureDirectory()` and write-probe pass successfully.
   - If directory creation fails (`EROFS`, `EACCES`, `EPERM`, `ENOSPC`), `this.initialized` is explicitly set to `false`.
2. **Dynamic Configuration Wiring**:
   - Remote config `config.offlineQueue` is passed directly into `persistentStorage.configure(...)`.
   - SDK initialization options accept `offlineQueue?: boolean | OfflineQueueInitOptions`.
   - `configApplier` responds dynamically to remote config diffs (`diff.changes.has('offlineQueue')`).
3. **At-Least-Once Delivery & Deduplication**:
   - Fallback-only persistence: events are only saved to disk when network delivery fails or during shutdown.
   - Every event maintains its cryptographically random UUIDv4 `eventId` across restarts, allowing backend ingestion to deduplicate seamlessly.

---

## 4. Edge Cases Addressed

| Edge Case | Failure Scenario Without Fix | SDK Behavior With Fix |
|---|---|---|
| **AWS Lambda Cold Start** | Resolves to `$HOME` (`/var/task`), throws `EROFS`, logs noisy warning, marks `isInitialized = true`, subsequent persists throw unhandled rejections. | Auto-detects Lambda, switches directory to `/tmp/pulse-sdk/events`, verifies writability. If unwritable, cleanly degrades to in-memory mode with debug log. |
| **K8s `readOnlyRootFilesystem: true`** | Pod crashes or fills logs with filesystem write errors on network drop. | Storage probe detects read-only filesystem, cleanly disables disk storage, logs single debug note, continues with in-memory retry. |
| **`offlineQueue: false` in Init** | Zod schema rejects with "unrecognized key `offlineQueue`", crashing user startup. | Added to `SDKInitOptions` and Zod schema. If `false`, disk I/O is 100% bypassed; no files created. |
| **Lambda Freeze on Return** | Background batch timers freeze in memory; telemetry for invocation is never delivered. | `wrapHandler` flushes pending telemetry synchronously before handler completion and prevents event loop stalls. |
| **Uncaught Handler Exception** | Error is captured, but Lambda terminates immediately before batch timer fires; error telemetry lost. | `wrapHandler` catches exception, invokes `captureException`, awaits synchronous flush, and rethrows original error. |
| **Disk Exhaustion (`ENOSPC`)** | Persistence attempts throw and crash host application. | All writes caught and handled via `writeChain`; storage catches `ENOSPC` and halts further disk writes until space is restored. |
| **Concurrent Process Access** | Two processes write to same file, causing corrupted NDJSON. | Unique API key hash suffix + PID/instance isolation prevents cross-process interference; replay skips corrupted lines defensively. |
| **Backend Remote Disable** | Operator disables offline queue in dashboard, but SDK keeps persisting to disk. | Config applier listens to `offlineQueueChanged` and reconfigures `persistentStorage.configure({ enabled: false })` dynamically. |
| **Slow Filesystem (NFS Hang)** | Graceful shutdown hangs for 30 seconds waiting for disk flush. | `withIoTimeout` limits every disk operation to `ioTimeoutMs` (default 5000ms), racing against timeout and releasing shutdown gracefully. |
| **Rapid Server Restarts** | Repeated restarts replay same events creating duplicate metrics/spans. | Fallback-only model: only undelivered events persisted. Events marked and deleted (`discard()`) upon 2xx backend ACK. |

---

## 5. Verification & Testing Strategy

1. **Unit Tests (`tests/unit/serverless-resilience.test.ts`)**:
   - Serverless environment auto-detection (AWS Lambda, Google Cloud Functions, Azure Functions, Vercel).
   - Safe directory resolution: Linux, Windows, macOS, container, serverless.
   - Filesystem writability probe and clean degradation on `EROFS` / `EACCES`.
   - `offlineQueue: false` and `offlineQueue: { enabled: false }` disabling disk I/O.
   - Remote config wiring and dynamic config updates.
   - `wrapHandler` normal execution, error capture, timeout enforcement, and `callbackWaitsForEmptyEventLoop`.
2. **Integration Verification**:
   - Full regression run across all 28 existing test suites (69 tests).
   - Zero test failures, zero type errors (`npx tsc --noEmit`).
3. **10 Real-World User Scenarios Audit**:
   - Documented real-world walkthrough of 10 enterprise user deployment scenarios.
