# Runtime Model & Guest-Process Contract

## 1. The Guest-Process Contract

When an application installs `@pulse-apm/node`, the SDK runs inside the same V8 isolate and on the same Node.js event loop as the customer's HTTP servers, database connections, and business logic. 

Because of this shared runtime environment, the SDK is governed by the **Guest-Process Contract**:

```
+-------------------------------------------------------------------+
|                        Node.js Process Space                      |
|                                                                   |
|   +-----------------------------------------------------------+   |
|   |                 Customer Application Domain               |   |
|   |  - HTTP Handlers        - Worker Jobs    - Event Loop     |   |
|   |  - Database Queries     - Memory Budget  - Process Life   |   |
|   +-----------------------------------------------------------+   |
|                                 |                                 |
|                         Shared Event Loop                         |
|                                 |                                 |
|   +-----------------------------------------------------------+   |
|   |                      Pulse SDK Domain                     |   |
|   |  - Zero sync I/O        - Unref'd timers - Non-blocking   |   |
|   |  - Bounded queues       - Worker offload - Contained errs |   |
|   +-----------------------------------------------------------+   |
+-------------------------------------------------------------------+
```

### Invariants:
1. **Host Event Loop Primacy:** Pulse must never monopolize the event loop. Synchronous execution time on any telemetry path must remain below sub-millisecond thresholds.
2. **Zero Synchronous Hot-Path I/O:** No `fs.readFileSync`, `fs.writeFileSync`, `execSync`, or `Atomics.wait` on any request or telemetry hot path.
3. **No Unhandled Rejections:** All internal asynchronous promises must possess explicit catch boundaries.
4. **No Unexpected Process Termination:** Pulse never invokes `process.exit()` or `process.abort()`.
5. **No Host Liveness Hostage:** Pulse background operations must not keep the Node.js process alive when the customer application has completed its work.

---

## 2. Event-Loop Safety Mechanisms

### 2.1 Micro-Yielding and Asynchronous Offloading
Telemetry capture functions (`captureError`, `captureMessage`, `captureEvent`, `captureMetric`) perform lightweight normalization in-place (< 100μs) and push the normalized record to the in-memory `EventQueue`. All downstream activities:
- JSON stringification
- Payload compression (Gzip/Brotli)
- Network HTTP dispatch
- Disk storage backups

execute asynchronously or offload to background worker threads via `SerializationPool` (`src/transport/serialization-pool.ts`).

### 2.2 Synchronous Operations Policy
The codebase strictly partitions synchronous work:
- **Permitted at Cold Startup (One-Time Only):** Reading package metadata during SDK bootstrap.
- **Forbidden on Hot Path:** Zero synchronous filesystem, socket, or crypto-heavy loops during runtime execution.

---

## 3. Process Liveness & Timer Governance

In Node.js, an active timer (`setTimeout`, `setInterval`) will keep the event loop alive and prevent the process from exiting naturally.

### 3.1 Unref Policy
Every timer instantiated by the Pulse SDK must be unreferenced using `.unref()` immediately upon creation:

```typescript
// Example from src/core/recovery-worker.ts
this.timer = setTimeout(() => {
  void this.executeAttempt();
}, delayMs);

if (typeof this.timer.unref === 'function') {
  this.timer.unref();
}
```

This applies to:
- Recovery worker polling intervals (`src/core/recovery-worker.ts`)
- Batch flush intervals (`src/transport/batch-manager.ts`)
- Health check and memory monitors (`src/transport/health-monitor.ts`)
- Connection pool keep-alive timers (`src/transport/connection-manager.ts`)

### 3.2 Liveness Verification
If a customer application runs a short-lived script:
```javascript
import { init } from '@pulse-apm/node';
await init({ apiKey: 'key_123' });
console.log('Script done');
```
The process will exit cleanly immediately after logging `"Script done"`, without being kept alive by Pulse recovery loops or batch timers.

---

## 4. Resource Boundedness

### 4.1 Memory Budgets
Pulse establishes an upper bound on heap usage via deterministic controls:
- **Global Queue Limit:** Default 1,000 events (`src/transport/queue.ts`).
- **Priority Tiering:** If the queue reaches capacity, normal and high-priority events are shed to ensure critical events (fatal errors, crash traces) fit within the ceiling.
- **Batch Buffers:** Dispatched batches are evicted from memory immediately upon transmission.

### 4.2 CPU Bounds
Under extreme burst conditions (e.g., 50,000 events generated during an outage), the SDK sheds events at the queue boundary in constant time $O(1)$, preventing quadratic CPU consumption or event-loop starvation.
