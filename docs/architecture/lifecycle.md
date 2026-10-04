# End-to-End Lifecycle

## 1. Lifecycle Overview

The execution lifecycle of `@pulse-apm/node` spans five distinct operational phases:

```
  +-----------------------------------------------------------------+
  | 1. Module Load & Bootstrap                                      |
  |    - Module imported via ESM / CJS / -r / --import              |
  |    - Native .env discovered and loaded                          |
  |    - Bootstrap auto-instrumentation hooks registered            |
  +-----------------------------------------------------------------+
                                  |
                                  v
  +-----------------------------------------------------------------+
  | 2. SDK Initialization (init())                                  |
  |    - Single-flight lock acquired                                |
  |    - State: created -> initializing                             |
  |    - Control-plane POST /v1/init dispatched                     |
  |         |                                 |                     |
  |     (Success)                         (Failure)                 |
  |         v                                 v                     |
  |    State: initialized                State: recovering          |
  |    Subsystems started                Recovery worker spawned    |
  |    Pre-init queue drained            Customer app continues     |
  +-----------------------------------------------------------------+
                                  |
                                  v
  +-----------------------------------------------------------------+
  | 3. Steady-State Telemetry Execution                             |
  |    - Traces, errors, metrics captured non-blocking              |
  |    - Events enqueued in 3-tier bounded EventQueue               |
  |    - Batches flushed asynchronously on timer or size threshold  |
  |    - Background worker threads serialize & compress payloads    |
  +-----------------------------------------------------------------+
                                  |
                                  v
  +-----------------------------------------------------------------+
  | 4. Failure & Self-Healing Loop (If Degraded)                    |
  |    - Circuit breaker trips on consecutive 5xx/timeouts          |
  |    - Rate limits / 429 backoff respected via Retry-After        |
  |    - Recovery worker retries /v1/init with jittered backoff     |
  |    - Late activation transitions recovering -> initialized      |
  +-----------------------------------------------------------------+
                                  |
                                  v
  +-----------------------------------------------------------------+
  | 5. Graceful Shutdown (shutdown())                               |
  |    - State: * -> stopping -> stopped                            |
  |    - SIGTERM/SIGINT intercepted or manual call                  |
  |    - In-flight requests aborted via AbortController             |
  |    - Recovery worker and timers cancelled                       |
  |    - Queues flushed with timeout deadline                       |
  |    - Worker threads terminated and OTel providers shut down     |
  +-----------------------------------------------------------------+
```

---

## 2. Phase 1: Module Load & Bootstrap

When `@pulse-apm/node` is evaluated by the Node.js runtime (even before `init()` is called):
1. **Module Preload Hook:** `registerBootstrapAutoInstrumentations()` in [`src/instrumentation/auto-instrument.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/auto-instrument.ts) executes immediately upon import.
2. **Early Monkey-Patching:** Node.js core modules (`http`, `https`) and installed third-party drivers (`pg`, `mongodb`, `redis`) receive their initial interception wrappers. This ensures that database clients instantiated before `await init()` are reliably instrumented.
3. **Pre-Init Buffer Active:** Any telemetry captured prior to `init()` entering an active state is queued into a pre-init buffer with priority shedding to prevent unbounded memory growth.

---

## 3. Phase 2: SDK Initialization

Invocation of `await init(options)` in [`src/core/init.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts) drives the control-plane handshake:
- **Option Normalization:** Normalizes API keys, endpoint URLs, and default limits.
- **Single-Flight Lock:** If concurrent `init()` invocations occur, all callers await the single in-flight Promise.
- **Control-Plane Request:** `RemoteConfigClient.post('/v1/init')` attempts to fetch configuration from the Pulse control plane within `initTimeoutMs` (default 5,000ms).
- **Branch A: Immediate Success:**
  - Remote config schema validated via Zod.
  - Subsystems dynamically initialized (`FeatureController.applyRemoteConfig()`).
  - Pre-init event buffer replayed into the main `EventQueue`.
  - State set to `'initialized'`.
- **Branch B: Transient Outage / Failure:**
  - Control-plane request times out or returns HTTP 5xx.
  - State transitions to `'recovering'`.
  - `BackgroundRecoveryWorker` spawned in background with unref'd timer.
  - **`init()` resolves cleanly** so the host application starts serving traffic without blocking.

---

## 4. Phase 3: Steady-State Execution

During application runtime:
- **Non-blocking Capture:** Calls to `captureError()`, `captureRequest()`, or tracing spans immediately submit events to the 3-tier bounded `EventQueue`.
- **Periodic Flushing:** `BatchManager` monitors queue sizes and per-route timer intervals (e.g., 1s for errors, 5s for traces).
- **Thread-Pool Offload:** Payloads exceeding worker thresholds are offloaded to `SerializationPool` worker threads to keep main-thread event-loop delay below 10ms.

---

## 5. Phase 4: Self-Healing & Recovery

If the control plane or ingestion pipeline degrades:
- **Background Recovery:** The recovery worker polls `/v1/init` on background intervals with exponential backoff (`[1s, 60s]`) and full jitter.
- **Late Activation:** When `/v1/init` succeeds, the SDK dynamically upgrades OTel providers, reconfigures routes, and enters `'initialized'` without restarting the host process.
- **Circuit Breaker:** Transport routes open their circuits upon consecutive failures, buffering critical events and discarding low-priority telemetry until health checks pass.

---

## 6. Phase 5: Graceful Shutdown

Upon process termination (`SIGTERM`, `SIGINT`, or explicit `await shutdown()`):
1. State changes to `'stopping'`.
2. Recovery worker timers and flush intervals are stopped and cleared.
3. In-flight control-plane requests are cancelled via `AbortController`.
4. In-flight telemetry batches are granted a bounded flush window (default 2,000ms) to drain to the network.
5. Worker threads are terminated.
6. OpenTelemetry TracerProvider is shut down.
7. State becomes `'stopped'`, permanently rejecting new operations.
