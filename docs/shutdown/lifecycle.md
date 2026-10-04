# Shutdown Sequence & Lifecycle

## 1. Overview

Teardown coordination is implemented in [`src/core/lifecycle.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts). When `shutdown(timeoutMs)` is called, the SDK executes a strict, ordered seven-phase shutdown sequence.

---

## 2. Seven-Phase Shutdown Sequence

```
Call: await shutdown(timeoutMs = 2000)
       |
       v
Phase 1: Engage Shutdown Barrier
       - State transition: * -> 'stopping'
       - Reject all new incoming telemetry capture calls
       |
       v
Phase 2: Stop Recovery & Background Workers
       - BackgroundRecoveryWorker.stop()
       - Clear all unref'd polling and heartbeat timers
       |
       v
Phase 3: Abort In-Flight Control-Plane Requests
       - Signal RemoteConfigClient.abort()
       - Cancel pending /v1/init promises
       |
       v
Phase 4: Flush Remaining Telemetry Queues
       - Dispatch all pending batches across all 10 routes
       - Await network acknowledgment within bounded deadline
       |
       v
Phase 5: Terminate Serialization Worker Pool
       - Stop worker message queues
       - Call worker.terminate()
       |
       v
Phase 6: Teardown OpenTelemetry Providers
       - TracerProvider.shutdown()
       - MeterProvider.shutdown()
       |
       v
Phase 7: Transition to Terminal State
       - State transition: 'stopping' -> 'stopped'
       - Clear activeClient instance
       - Return clean resolution
```

---

## 3. Step Deadlines & Timeout Protection

If network connectivity is degraded during container shutdown, the flush phase must not hang the container indefinitely until the orchestrator sends `SIGKILL`.

- The `timeoutMs` parameter (default: 2,000ms) establishes a hard deadline for the entire shutdown sequence.
- If in-flight network flushes have not completed within the timeout window, the SDK logs a diagnostic summary (`"Telemetry shutdown completed {"timedOut":true...}"`) and proceeds immediately to terminate workers and sockets.
- The host process is allowed to exit gracefully within its orchestrator budget.
