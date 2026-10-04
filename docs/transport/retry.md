# Network Retry Policies & Backoff

## 1. Overview

In distributed architectures, transient network disconnects, DNS timeouts, and temporary load spikes are inevitable. The transport layer in [`src/transport/retry.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/retry.ts) implements resilient retry strategies to maximize telemetry delivery without overwhelming the host application or remote infrastructure.

---

## 2. Retry Decision Matrix

When a batch transmission fails, the SDK classifies the error:

```
                      Outbound Dispatch Fails
                                |
                                v
               Is Error Retryable and Within Limits?
                                |
               +----------------+----------------+
               |                                 |
              Yes                                No
               |                                 |
               v                                 v
    Calculate Backoff Delay               Permanent Drop
   (Base: 500ms, Exponential,             (Log error, evict
    Jitter: 50%, Max Attempts: 3)          from memory buffer)
               |
               v
       Re-enqueue to Route
       (or Dead-Letter Buffer)
```

### Classification Rules:
- **Retryable Errors:** Socket timeouts (`ETIMEDOUT`), connection resets (`ECONNRESET`), DNS lookup failures (`ENOTFOUND`, `EAI_AGAIN`), HTTP 429, HTTP 500, 502, 503, 504.
- **Non-Retryable Errors:** HTTP 400 (Bad Schema), HTTP 401 (Unauthorized), HTTP 403 (Forbidden), payload size limit exceeded (> 10MB).

---

## 3. Backoff Formula & Retry Limits

The retry delay for failed batches uses truncated exponential backoff with full jitter:

$$\text{delay} = \min\left(10000, 500 \times 2^{\text{attempt}}\right) \times (0.5 + 0.5 \times \text{Math.random}())$$

- **Maximum Retry Attempts:** Default `3` attempts per batch.
- **Max Retry Delay:** `10,000 ms` (10 seconds).
- **Dead-Letter Handling:** Batches exceeding the maximum retry count are moved to a bounded dead-letter queue (max 500 items) or evicted to preserve process memory.
