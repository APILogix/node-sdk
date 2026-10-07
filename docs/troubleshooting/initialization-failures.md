# Diagnosing Initialization Failures

## 1. Overview

During application startup, the Pulse SDK dispatches an HTTP POST request to `/v1/init`. If this request fails, the SDK logs a message and transitions to `'recovering'`:

```
[Pulse] ERROR: Telemetry initialization failed; entering dormant state {
  "error": { "code": "NETWORK_ERROR", "message": "Control-plane request failed" }
}
[Pulse] INFO: SDK entering background recovery mode.
```

The host application continues running without disruption.

---

## 2. Common Causes & Diagnostics

### 2.1 Network Connectivity & Firewalls
- **Requirement:** Outbound HTTPS access on TCP port 443 to `ingest.pulse.io` (or your custom `PULSE_ENDPOINT`).
- **Test with curl:**
  ```bash
  curl -v https://ingest.pulse.io/v1/init
  ```
- **Corporate Proxies:** If your environment requires an egress proxy, ensure `HTTPS_PROXY` or `HTTP_PROXY` is set in `process.env`.

### 2.2 DNS Resolution Failures (`ENOTFOUND`, `EAI_AGAIN`)
- If running in Docker or Kubernetes, ensure the container's `/etc/resolv.conf` can resolve public or internal domain names.
- Temporary DNS glitches trigger automatic exponential backoff retries via `BackgroundRecoveryWorker`.

### 2.3 Strict Timeout Exceeded (`ETIMEDOUT`)
- By default, `/v1/init` allows `initTimeoutMs: 5000` (5 seconds).
- If your container boots under extreme CPU throttling, increase the timeout:
  ```typescript
  await init({
    apiKey: '...',
    initTimeoutMs: 10000, // 10 seconds
  });
  ```
