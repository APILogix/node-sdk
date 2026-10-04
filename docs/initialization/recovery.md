# Background Recovery Worker

## 1. Purpose & Guarantees

If the initial call to `/v1/init` fails during application cold start, the SDK transitions to the `'recovering'` state and launches the `BackgroundRecoveryWorker` ([`src/core/recovery-worker.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/recovery-worker.ts)).

### Guarantees:
1. **Host Isolation:** Recovery execution occurs entirely in the background. It never blocks the event loop or throws exceptions to user code.
2. **Process Liveness:** Timers are unreferenced via `.unref()` so the worker never prevents natural process termination.
3. **Single-Flight Coordination:** Exactly **one** recovery loop executes per SDK client instance.
4. **Shutdown Dominance:** Calling `shutdown()` cancels all scheduled recovery timers and aborts in-flight network attempts immediately.

---

## 2. Exponential Backoff & Jitter Algorithm

The recovery worker schedules retry attempts using truncated exponential backoff with full decorrelated jitter to avoid the "thundering herd" problem against the control plane:

$$\text{delay} = \min\left(\text{maxDelay}, \text{baseDelay} \times 2^{\text{attempt}}\right) \times (0.5 + 0.5 \times \text{Math.random}())$$

### Parameters:
- **Base Delay:** Default `1,000ms` (1 second).
- **Max Delay:** Default `60,000ms` (60 seconds).
- **Jitter Range:** 50% to 100% randomization factor.

### Dynamic `Retry-After` Header Respect:
If the control plane responds with HTTP 429 (Too Many Requests) or HTTP 503 (Service Unavailable) including a `Retry-After` header:
- The worker parses the header value (in integer seconds or HTTP date format).
- The scheduled backoff delay is dynamically extended to respect the server-specified cooldown, capped at `300,000ms` (5 minutes).

---

## 3. Transient vs. Permanent Error Classification

The recovery worker classifies control-plane errors to determine whether retries should continue:

| Error Category | Examples | Action |
|---|---|---|
| **Transient Network Errors** | `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN` | Retry with exponential backoff. |
| **Transient HTTP Errors** | HTTP 429, 500, 502, 503, 504 | Retry with exponential backoff and `Retry-After`. |
| **Permanent Client Errors** | HTTP 401 (Invalid API Key), 403 (Project Disabled), 400 (Bad Schema) | Stop recovery permanently. Log fatal configuration error once. |

---

## 4. Production Hardening: `PULSE_TEST_RECOVERY_DELAY_MS`

To allow fast execution of automated test suites without waiting for 1,000ms production timers, the SDK supports `PULSE_TEST_RECOVERY_DELAY_MS`.

During the final adversarial audit, strict production hardening was implemented in [`src/core/recovery-worker.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/recovery-worker.ts#L20-L40):

```typescript
export function getDefaultBaseDelayMs(): number {
  // STRICT PRODUCTION GUARD: Never allow test delay overrides in production
  if (process.env['NODE_ENV'] === 'production' || process.env['PULSE_ENV'] === 'production') {
    return 1_000;
  }

  const testDelay = process.env['PULSE_TEST_RECOVERY_DELAY_MS'];
  if (testDelay) {
    const parsed = Number(testDelay);
    if (!Number.isNaN(parsed) && parsed > 0) {
      // Clamp test delay to safe lower and upper bounds
      return Math.min(Math.max(parsed, 10), 60_000);
    }
  }

  return 1_000;
}
```

### Protection:
- In production (`NODE_ENV=production` or `PULSE_ENV=production`), `PULSE_TEST_RECOVERY_DELAY_MS` is completely ignored, preventing aggressive spin-loops against production control planes.
- In test/development environments, test delays are clamped between `10ms` and `60,000ms` to prevent negative or zero-interval spin-locks.
