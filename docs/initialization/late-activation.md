# Late Activation

## 1. What is Late Activation?

In distributed environments, the Pulse control plane may be temporarily unreachable when a customer application starts up. The host application starts serving traffic immediately while the SDK operates in dormant `'recovering'` mode.

When the control plane recovers (whether after 10 seconds or 10 minutes) and the `BackgroundRecoveryWorker` receives a successful response from `/v1/init`, the SDK undergoes **Late Activation**.

Late Activation transitions the SDK from `'recovering'` to `'initialized'` seamlessly in-flight without requiring a process restart.

---

## 2. Dynamic Activation Steps

```
Background Recovery Worker: /v1/init Success
                      |
                      v
       1. Verify State Machine Pre-condition
          (Must be in 'recovering'; if 'stopping' or 'stopped', abort)
                      |
                      v
       2. Validate & Store Remote Configuration
                      |
                      v
       3. Dynamic Subsystem Spin-Up
          - FeatureController activates tracing, metrics, errors
          - OpenTelemetry hooks enabled without duplicate patching
                      |
                      v
       4. Transport Route Reconfiguration
          - Dedicated route queues initialized
          - Batch intervals and sizes configured
                      |
                      v
       5. Pre-Init / Recovery Queue Replay & Drain
          - Buffered critical errors and spans transferred to EventQueue
                      |
                      v
       6. Transition State to 'initialized'
          - Logging confirms successful recovery activation
```

---

## 3. Preserving Context Across Activation

A critical challenge during late activation is ensuring that in-flight requests running on `AsyncLocalStorage` do not lose context or generate corrupted spans when the SDK becomes active mid-request.

### Guarantees:
- **`AsyncLocalStorage` Continuity:** The request store initialized by `monitorMiddleware()` or `createContextStore()` remains active across recovery boundaries.
- **Traceparent Consistency:** Any W3C traceparent headers parsed from incoming HTTP requests while in `'recovering'` mode are preserved and attached to the root span once tracing activates.
- **No Duplicate Span Multiplicity:** Verified by adversarial test suite: repeated cycles between `'recovering'` and `'initialized'` generate exactly **1** span per operation, never duplicated spans or leaked interceptors.
