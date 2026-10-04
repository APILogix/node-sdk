# Circuit Breaker Architecture

## 1. Overview

To prevent persistent socket exhaustion and wasteful CPU cycles during prolonged infrastructure blackouts, every telemetry route maintains an independent `CircuitBreaker` ([`src/transport/circuit-breaker.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/circuit-breaker.ts)).

---

## 2. Circuit Breaker State Machine

```
              +---------------------------------------------+
              |                                             |
              v                                             | Success
        +------------+       5 Consecutive Failures   +------------+
        |   CLOSED   | -----------------------------> |    OPEN    |
        +------------+                                +------------+
              ^                                             |
              |                                             | 30s Cooldown
              | Success                                     v
        +------------+                             +------------+
        | HALF_OPEN  | <-------------------------- |  Cooldown  |
        +------------+        1 Probe Allowed      +------------+
              |
              | Failure
              v
        (Return to OPEN)
```

### States:
- **`CLOSED` (Normal):** Telemetry flows freely. Consecutive failures are tracked.
- **`OPEN` (Tripped):** When 5 consecutive delivery failures occur on a route, the circuit trips to `OPEN`. Outbound network requests for that route are immediately suspended for a 30-second cooldown window. Non-critical telemetry is dropped at the queue boundary to save memory.
- **`HALF_OPEN` (Probe):** After the cooldown window expires, the circuit allows exactly one trial batch to test endpoint connectivity.
  - If the trial batch succeeds, the circuit resets to `CLOSED`.
  - If the trial batch fails, the circuit immediately returns to `OPEN` for another cooldown period.

---

## 3. Operational Monitoring

The status of all route circuit breakers can be inspected via `getSDKHealth()`:

```typescript
import { getSDKHealth } from '@pulse-apm/node';

const health = getSDKHealth();
console.log('Circuit States:', health.routeCircuits);
// Example: { errors: 'CLOSED', traces: 'OPEN', metrics: 'CLOSED' }
```
