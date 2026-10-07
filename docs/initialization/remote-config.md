# Remote Configuration

## 1. Overview

The Pulse SDK is dynamically configured via the control plane during initialization. This allows remote tuning of telemetry volume, sampling rates, killswitches, PII scrub rules, and transport batch parameters without requiring host application redeployments.

The remote configuration client resides in [`src/core/remote-config-client.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/remote-config-client.ts) and schema definitions reside in [`src/types/config.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/config.ts).

---

## 2. Handshake Protocol (`/v1/init`)

### 2.1 Request Payload
The SDK transmits an initial identification handshake via HTTP POST to `/v1/init`:

```json
{
  "projectId": "proj_prod_991823",
  "environment": "production",
  "release": "1.4.0",
  "sdk": {
    "name": "@pulse-apm/node",
    "version": "8.4.5",
    "runtime": "node",
    "runtimeVersion": "v20.11.0"
  },
  "capabilities": [
    "tracing",
    "metrics",
    "errors",
    "logs",
    "profiles",
    "replays",
    "crons"
  ]
}
```

### 2.2 Response Payload Schema
The response payload is strictly validated via Zod (`RemoteConfigResponseSchema`):

```json
{
  "success": true,
  "projectId": "proj_prod_991823",
  "environment": "production",
  "release": "1.4.0",
  "schemaVersion": "1.0",
  "config": {
    "sdk": {
      "enabled": true,
      "logLevel": "warn"
    },
    "features": {
      "tracing": { "enabled": true, "captureSpans": true },
      "metrics": { "enabled": true },
      "errors": { "enabled": true },
      "logs": { "enabled": true },
      "profiling": { "enabled": false },
      "sessionReplay": { "enabled": false },
      "crons": { "enabled": true }
    },
    "sampling": {
      "traces": 1.0,
      "requests": 1.0,
      "logs": 0.5,
      "adaptive": {
        "enabled": true,
        "targetEventsPerSecond": 500,
        "criticalPreservation": true
      }
    },
    "limits": {
      "maxQueueSize": 1000,
      "maxBatchSize": 100,
      "maxPayloadSizeBytes": 5242880
    },
    "transport": {
      "routes": {
        "errors": { "batchSize": 100, "flushIntervalMs": 1000, "priority": "critical" },
        "events": { "batchSize": 50, "flushIntervalMs": 5000, "priority": "normal" },
        "traces": { "batchSize": 500, "flushIntervalMs": 5000, "priority": "high" }
      }
    },
    "privacy": {
      "scrubFields": ["password", "token", "secret", "authorization"],
      "maskCreditCards": true
    },
    "killswitches": {
      "disableAllTracing": false,
      "disableProfiling": true
    }
  }
}
```

---

## 3. Subsystem Ingestion via FeatureController

When remote configuration arrives, `FeatureController` in [`src/core/feature-controller.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/feature-controller.ts) distributes directives across subsystems:

1. **Killswitch Evaluation:** If `killswitches.disableAllTracing` is set, all trace aggregators and span creation functions enter short-circuit no-op mode immediately.
2. **Transport Route Reconfiguration:** `TransportRouter` updates batch sizes, compression formats (Gzip/Brotli), and flush timers across all 10 independent telemetry pipelines.
3. **Sampling Recalibration:** `RemoteConfigSampler` recalculates deterministic sampling thresholds based on dynamic rates.
4. **Scrubber Rules Applied:** `SecurityScrubber` appends tenant-specific sensitive keys to the recursive PII redactor.

---

## 4. Local Configuration Caching

If enabled via `configCacheTtlMs`, the SDK caches valid remote configuration responses to local storage (`src/storage/config-cache.ts`). If subsequent starts encounter transient network failures, the SDK immediately hydrates from the local cache to activate telemetry without waiting for recovery completion.
