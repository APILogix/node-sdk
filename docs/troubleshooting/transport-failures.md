# Resolving Transport & Delivery Failures

## 1. Overview

Transport delivery failures occur when the SDK successfully initializes, but subsequent telemetry batches sent to `/v1/errors`, `/v1/traces`, or `/v1/metrics` fail to reach the ingestion servers.

---

## 2. Diagnosing Common Transport Errors

### 2.1 HTTP 429 (Too Many Requests / Quota Exhaustion)
- **Symptom:** `getSDKHealth().quota.isExhausted === true`.
- **Cause:** Your monthly or hourly ingestion limit has been exceeded.
- **SDK Behavior:** The SDK automatically pauses non-critical route dispatches to save socket and CPU resources for the duration specified in the `Retry-After` header. Critical errors continue to be reserved in the `EventQueue`.
- **Solution:** Upgrade your account plan or increase the quota limit in the Pulse management console.

### 2.2 Circuit Breaker Tripped (`OPEN`)
- **Symptom:** `getSDKHealth().routeCircuits.traces === 'OPEN'`.
- **Cause:** A route encountered 5 consecutive delivery failures (e.g., downstream 503 or socket timeouts).
- **SDK Behavior:** The SDK suspends dispatches for 30 seconds, drops incoming low-priority events to protect memory, and then sends a trial batch in `HALF_OPEN` state.
- **Solution:** Verify backend health. The circuit will automatically heal once connectivity is restored.

### 2.3 Dropped Events
- **Symptom:** `getSDKHealth().queueDropped > 0`.
- **Cause:** The `EventQueue` reached its `maxSize` (default: 1,000) during a sustained outage or traffic burst.
- **Interpretation:** This is expected, fail-safe degradation designed to prevent host memory exhaustion. Critical events are preserved while normal logs/metrics are shed.
