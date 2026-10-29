# Static Configuration Reference

## 1. Overview

The Pulse SDK is initialized via `init(options)`. The options object conforms to `SDKInitOptions` defined in [`src/types/config.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/config.ts).

---

## 2. Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| **`apiKey`** | `string` | `process.env.PULSE_API_KEY` | **Required.** Pulse APM project API key. |
| **`endpoint`** | `string` | `https://ingest.pulse.io` | Custom control-plane and ingestion base URL. |
| **`environment`** | `string` | `process.env.NODE_ENV` \|\| `'development'` | Environment tag (`production`, `staging`, `development`). |
| **`release`** | `string` | Auto-detected from Git/package.json | Application release or Git commit SHA. |
| **`serviceName`** | `string` | `package.json#name` | Logical service name for distributed tracing. |
| **`enabled`** | `boolean` | `true` | Master killswitch to enable or disable the SDK completely. |
| **`debug`** | `boolean` | `false` | Enable verbose internal SDK debug logs to console. |
| **`logLevel`** | `'debug'\|'info'\|'warn'\|'error'` | `'warn'` | Minimum log severity for internal SDK logs. |
| **`initTimeoutMs`** | `number` | `5000` | Maximum milliseconds to await `/v1/init` before entering recovery mode. |
| **`initRetries`** | `number` | `1` | Number of immediate synchronous retries during `init()`. |
| **`beforeSendTimeoutMs`** | `number` | `1000` | Maximum time allowed for user and plugin `beforeSend` hooks. Valid range: 1–30000 ms; events are dropped if a hook throws or exceeds the deadline. |
| **`maxQueueSize`** | `number` | `1000` | Maximum number of telemetry events retained in memory queue. |
| **`sampleRate`** | `number` | `1.0` | Base static trace sampling rate ($0.0$ to $1.0$). |
| **`maskCreditCards`**| `boolean` | `true` | Automatically detect and mask credit card numbers. |
| **`scrubFields`** | `string[]` | `['password', 'token', 'secret', 'authorization']` | Additional sensitive object keys to redact from telemetry. |
| **`autoInstrument`** | `boolean` | `true` | Automatically monkey-patch supported database and HTTP libraries. |

String values longer than 8 KiB are scanned only through the first 8 KiB; the unscanned suffix is omitted from telemetry and the output ends with a `[truncated]` marker.

---

## 3. Configuration Precedence

When conflicting settings are provided, Pulse resolves configuration in the following order of precedence (highest to lowest):

1. **Explicit `init(options)` arguments** (passed directly by developer in code).
2. **Control-plane Remote Configuration** (received dynamically from `/v1/init`).
3. **Environment Variables** (`PULSE_API_KEY`, `PULSE_ENDPOINT`, etc.).
4. **Built-in SDK Defaults** (defined in `src/constants/defaults.ts`).
