# Remote Configuration Directives

## 1. Overview

Control-plane remote configuration allows real-time operational adjustments to live applications without code changes or container restarts.

Remote configuration is delivered via `/v1/init` and periodically refreshed. All directives are validated against the `RemoteConfigResponseSchema` in [`src/types/config.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/config.ts).

---

## 2. Configurable Directives

### 2.1 Feature Flags & Subsystem Control
```json
"features": {
  "tracing": { "enabled": true, "captureSpans": true },
  "metrics": { "enabled": true },
  "errors": { "enabled": true },
  "logs": { "enabled": true },
  "profiling": { "enabled": false },
  "sessionReplay": { "enabled": false },
  "crons": { "enabled": true }
}
```
Enabling or disabling a feature toggles the corresponding subsystem dynamically via `FeatureController` without unpatching Node.js libraries.

### 2.2 Global Killswitches
```json
"killswitches": {
  "disableAllTracing": false,
  "disableProfiling": true,
  "dropAllTelemetry": false
}
```
If an upstream issue occurs, `dropAllTelemetry: true` instructs the SDK to drop all telemetry in-process immediately, completely eliminating outbound network traffic.

### 2.3 Route & Batch Tuning
```json
"transport": {
  "routes": {
    "errors": { "batchSize": 100, "flushIntervalMs": 1000, "compression": "gzip" },
    "traces": { "batchSize": 500, "flushIntervalMs": 5000, "compression": "gzip" },
    "metrics": { "batchSize": 1000, "flushIntervalMs": 10000, "compression": "gzip" }
  }
}
```
Allows adjusting batch sizes, flush frequencies, and compression algorithms dynamically based on fleet traffic volume.
