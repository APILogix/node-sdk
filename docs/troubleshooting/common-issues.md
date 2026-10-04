# Troubleshooting & Diagnostic Guide

## 1. Quick Diagnostics

### 1.1 Enable Debug Logging
To view internal SDK operations, connection attempts, and configuration directives in real-time, set `PULSE_DEBUG=true` or pass `debug: true`:

```typescript
await init({
  apiKey: process.env.PULSE_API_KEY!,
  debug: true,
  logLevel: 'debug',
});
```

### 1.2 Inspect Runtime SDK Health
Call `getSDKHealth()` anywhere in your application or expose it in an internal `/admin/pulse-health` endpoint:

```typescript
import { getSDKHealth } from '@pulse-apm/node';

app.get('/admin/pulse-health', (req, res) => {
  res.json(getSDKHealth());
});
```

---

## 2. Common Symptoms & Solutions

### 2.1 No Traces Appearing in Dashboard
- **Check API Key:** Ensure `PULSE_API_KEY` is set correctly. Check console for `401 Unauthorized` logs.
- **Check Import Order:** If using ESM, make sure `@pulse-apm/node` is imported before database drivers or HTTP frameworks:
  ```bash
  node --import @pulse-apm/node/register app.js
  ```
- **Check Sampling Rate:** If running under high load, adaptive sampling may throttle 200 OK traces. Fatal errors bypass sampling; check if errors appear.

### 2.2 Missing Database Spans
- **Ensure Bootstrap Ran:** If database clients (`pg`, `redis`, `mongodb`) were initialized before `await init()`, ensure `@pulse-apm/node` was imported at the very top of your entry file.
- **Check Subsystem Entitlements:** Remote configuration may have disabled database tracing for your tier. Check `debug: true` logs for `"[FeatureController] Skipping subsystem: tracing"`.

### 2.3 "Telemetry initialization failed; entering dormant state"
- **Normal Fail-Safe Behavior:** This log indicates that the control plane (`/v1/init`) was unreachable during startup.
- **Action:** The host application will continue running normally, and the `BackgroundRecoveryWorker` will self-heal automatically once backend connectivity is restored.
