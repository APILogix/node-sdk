# State Machine & Lifecycle Transitions

## 1. Formal State Model

The Pulse Node.js SDK lifecycle is governed by a finite state machine defined in [`src/core/client.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/client.ts). The client can exist in one of six formal states:

```
  +---------+
  | created | <------------------ (Initial state upon module import)
  +---------+
       |
       | init()
       v
+--------------+        failure
| initializing | ----------------------+
+--------------+                       |
       |                               |
       | success                       v
       v                        +------------+
+-------------+      success    | recovering | <---+
| initialized | <-------------- +------------+     | (retry failure)
+-------------+                        |           |
       |                               +-----------+
       |                                     |
       | shutdown()                          | shutdown()
       +-----------------+                   |
                         |                   |
                         v                   v
                  +--------------------------------+
                  |            stopping            |
                  +--------------------------------+
                                 |
                                 | teardown complete
                                 v
                  +--------------------------------+
                  |       stopped (Terminal)       |
                  +--------------------------------+
```

---

## 2. Legal State Transitions

The transition table is strictly enforced by `PulseClient.setState(newState)`:

| Current State | Trigger / Event | Target State | Notes |
|---|---|---|---|
| `created` | `init()` invoked | `initializing` | Initial startup call. Single-flight lock engaged. |
| `initializing` | `/v1/init` returns HTTP 200 & valid config | `initialized` | Cold start success. Subsystems activated. |
| `initializing` | `/v1/init` fails (network error, 5xx, timeout) | `recovering` | Enters background retry loop. `init()` resolves cleanly. |
| `recovering` | Background recovery attempt succeeds | `initialized` | Late activation. Dynamic subsystem upgrades. |
| `recovering` | Background recovery attempt fails | `recovering` | Exponential backoff recalculation; schedules next tick. |
| `created` | `shutdown()` invoked | `stopping` | Direct teardown before initialization. |
| `initializing` | `shutdown()` invoked | `stopping` | Aborts in-flight control-plane fetch via AbortController. |
| `recovering` | `shutdown()` invoked | `stopping` | Cancels background retry timer and unrefs worker. |
| `initialized` | `shutdown()` invoked | `stopping` | Drains queues and stops telemetry ingestion. |
| `stopping` | Teardown finishes | `stopped` | Terminal state. Permanent shutdown. |
| `stopped` | Explicit `init()` with force re-init | `initializing` | Only permitted when explicitly resetting client. |

---

## 3. Illegal Transitions & Defensive Guards

Any state transition not explicitly declared in the transition table throws an `SDKError` with code `INVALID_STATE_TRANSITION`.

```typescript
// Guard implementation in src/core/client.ts
private isValidTransition(from: ClientState, to: ClientState): boolean {
  const transitions: Record<ClientState, ClientState[]> = {
    created: ['initializing', 'stopping', 'stopped'],
    initializing: ['initialized', 'recovering', 'stopping', 'stopped'],
    recovering: ['initialized', 'recovering', 'stopping', 'stopped'],
    initialized: ['stopping', 'stopped'],
    stopping: ['stopped'],
    stopped: ['initializing'], // Controlled re-init only
  };
  return transitions[from]?.includes(to) ?? false;
}
```

---

## 4. Shutdown Dominance & Late Callback Protection

### 4.1 Race Condition Defenses
In asynchronous distributed environments, network responses or timers may fire after a user has initiated shutdown:

```
Thread Timeline:
-------------------------------------------------------------------->
init() starts ---> [ /v1/init in-flight ] -------------------------> Network 200 arrives!
                           |
                           v
                       shutdown() called ---> State: stopping -> stopped
```

If the resolving `/v1/init` promise attempted to transition the state from `'stopping'` to `'initialized'`, it would corrupt the terminal shutdown sequence.

### 4.2 Implementation Barrier
In [`src/core/init.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts), defensive guards verify the state before executing transitions:

```typescript
// In src/core/init.ts initialize()
if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
  return undefined;
}
```

If the SDK has entered `'stopping'` or `'stopped'`:
- In-flight control plane responses are discarded immediately.
- No subsystems are started.
- No timers are rescheduled.
- No zombie background workers are spawned.
- The state remains locked in `'stopping'` or `'stopped'`.

### 4.3 Stale Recovery Worker Defenses
The `BackgroundRecoveryWorker` checks `client.getState()` at the entry of every retry tick:
```typescript
if (client.getState() === 'stopping' || client.getState() === 'stopped') {
  this.stop();
  return;
}
```
This guarantees that shutdown **always wins** any race against delayed control-plane responses or asynchronous timers.
