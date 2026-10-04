# Initialization Flow

## 1. Overview

The initialization sequence of `@pulse-apm/node` is managed by `init(options)` in [`src/core/init.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/init.ts). It guarantees that the host application never blocks indefinitely or crashes if the Pulse backend control plane is unavailable or slow.

---

## 2. Step-by-Step Execution Sequence

```
Caller Invokes: await init(options)
       |
       v
1. Normalize & Validate Options
       - String shorthand expanded to { apiKey: "..." }
       - Environment discovery (.env fallback)
       - Validate required fields (apiKey)
       |
       v
2. Single-Flight Concurrency Lock
       - Check if already initialized or in-flight
       - Multiple callers join the existing Promise
       |
       v
3. State Transition: created -> initializing
       |
       v
4. Control-Plane Request (POST /v1/init)
       - Dispatched via RemoteConfigClient
       - Timeout governed by initTimeoutMs (default: 5000ms)
       - Retries governed by initRetries (default: 1)
       |
       +---------------------------------------------+
       |                                             |
   (Success: HTTP 200 + Valid JSON)          (Failure: Timeout / 5xx / Network Error)
       |                                             |
       v                                             v
5a. Cold-Start Success Branch                 5b. Background Recovery Branch
   - Zod schema validation                       - Catch error without throwing
   - Apply remote configuration                  - State: initializing -> recovering
   - Activate subsystems (tracing, metrics)      - Spawn BackgroundRecoveryWorker
   - Drain pre-init event buffer                 - Return undefined
   - State: initializing -> initialized          - Customer application continues!
   - Return RemoteConfigResponse
```

---

## 3. Options Normalization & Discovery

Initialization accepts either a full options object (`SDKInitOptions`) or a string API key:
```typescript
await init('pls_live_12345');
// or
await init({
  apiKey: 'pls_live_12345',
  endpoint: 'https://custom-ingest.pulse.io',
  environment: 'production',
  initTimeoutMs: 3000,
});
```

### Auto-Discovery Rules:
If parameters are omitted, the SDK reads from `process.env`:
- `PULSE_API_KEY`
- `PULSE_ENDPOINT` or `PULSE_API_URL` or `BACKEND_URL`
- `PULSE_ENV` or `NODE_ENV`
- `PULSE_RELEASE` or `npm_package_version`

---

## 4. Single-Flight Concurrency Guarantee

If concurrent application modules or async workers call `init()` simultaneously, the SDK uses a module-level lock (`activeInitPromise`):

```typescript
// Implementation in src/core/init.ts
if (activeInitPromise) {
  return activeInitPromise;
}

if (client.initialized) {
  return Promise.resolve(client.getRemoteConfig());
}

activeInitPromise = (async () => {
  try {
    return await executeInit(normalizedOptions);
  } finally {
    activeInitPromise = null;
  }
})();
```

This guarantees:
- Exactly **one** `/v1/init` control-plane HTTP request is issued.
- No duplicate queues, timers, or instrumentation instances are created.

---

## 5. Cold-Start Success Branch

When `/v1/init` returns HTTP 200:
1. **Schema Validation:** The response payload is validated against `RemoteConfigResponseSchema` in `src/types/config.ts`.
2. **Configuration Cache Updated:** A local cache snapshot is persisted if disk storage is enabled (`src/storage/config-cache.ts`).
3. **Subsystems Initialized:** `FeatureController.applyRemoteConfig()` configures:
   - Dynamic sampling rates per route
   - Killswitch evaluation for disabled features
   - Multiplexed transport routes and batch sizes
   - OpenTelemetry runtime providers
4. **Pre-Init Event Drain:** Events buffered in memory prior to initialization completion are flushed into the active `EventQueue`.
5. **State Set to `'initialized'`:** Telemetry transmission begins immediately.

---

## 6. Outage & Failure Isolation Branch

If the control plane fails to respond, drops connections (`ECONNRESET`), returns HTTP 500/502/503/504, or times out:
1. **Error Caught Internally:** The exception is caught within `executeInit()`. It is logged as an informational warning and **never thrown** to the host process.
2. **State Set to `'recovering'`:** The client marks itself as dormant/recovering.
3. **Recovery Worker Spawned:** `BackgroundRecoveryWorker.start()` registers an unref'd exponential backoff timer.
4. **Control Returned to Host:** `init()` resolves cleanly with `undefined`. The customer application proceeds to listen for HTTP requests immediately without delay.
