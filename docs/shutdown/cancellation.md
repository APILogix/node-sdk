# Cancellation & Zombie Worker Prevention

## 1. The Zombie Worker Threat

A common defect in background Node.js agents is the "zombie worker" issue:
1. Application initiates shutdown.
2. An asynchronous background task (e.g., recovery retry loop, metric harvester, or batch flusher) remains scheduled or in-flight.
3. The background task finishes *after* shutdown, creates new network connections, restarts timers, or revives the client state from `'stopped'` to `'initialized'`.
4. The process hangs indefinitely or logs uncaught error rejections.

Pulse guarantees **Total Cancellation & Zombie Prevention**.

---

## 2. Abort Signal Propagation

During shutdown, an `AbortSignal` is propagated across all internal asynchronous engines:

```typescript
// Pattern used across Pulse subsystems
public stop(): void {
  // 1. Clear scheduled timer
  if (this.timer) {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // 2. Abort active network requests
  if (this.abortController) {
    this.abortController.abort();
  }

  // 3. Mark internal stopped flag
  this.stopped = true;
}
```

---

## 3. Terminal State Enforcement

The state machine strictly treats `'stopped'` as terminal:
- Any callback resolving after `'stopped'` is entered checks `client.getState() === 'stopped'` and returns immediately without taking action.
- Telemetry capture functions called after shutdown return no-op receipts or log a single warning.
- All internal event listeners on `process` or `EventEmitter` are unregistered, allowing the V8 garbage collector to reclaim all SDK instances and memory.
