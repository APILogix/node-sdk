# Environment Variables & Discovery

## 1. Zero-Dependency Native `.env` Discovery

The Pulse SDK features built-in `.env` file discovery in [`src/utils/env-loader.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/env-loader.ts). It automatically searches for `.env`, `.env.local`, and `.env.production` files in the current working directory without requiring external dependencies like `dotenv`.

---

## 2. Environment Variables Reference

| Variable | Description | Default Fallback |
|---|---|---|
| **`PULSE_API_KEY`** | Pulse APM Project API Key. | None (Required) |
| **`PULSE_ENDPOINT`** | Custom ingestion and control-plane URL. | `https://ingest.pulse.io` |
| **`PULSE_API_URL`** | Alias for `PULSE_ENDPOINT`. | — |
| **`BACKEND_URL`** | Legacy alias for `PULSE_ENDPOINT`. | — |
| **`PULSE_ENV`** | Environment name (`production`, `staging`, `dev`). | Reads `NODE_ENV` or `'development'` |
| **`NODE_ENV`** | Node.js standard environment identifier. | `'development'` |
| **`PULSE_RELEASE`** | Application deployment version or Git commit SHA. | Auto-detected from Git/package.json |
| **`PULSE_SERVICE_NAME`**| Logical name for the application service. | `package.json#name` |
| **`PULSE_DEBUG`** | Set to `'true'` or `'1'` to enable verbose debug logging. | `false` |
| **`PULSE_LOG_LEVEL`** | Minimum log level (`debug`, `info`, `warn`, `error`). | `'warn'` |

---

## 3. Special Testing Variables

### `PULSE_TEST_RECOVERY_DELAY_MS`
- **Purpose:** Accelerates the background recovery worker delay during automated unit/integration tests.
- **Production Guard:** **Strictly ignored** when `NODE_ENV=production` or `PULSE_ENV=production`. In production, the SDK always enforces the safe 1,000ms base delay.
- **Clamping:** In non-production environments, values are clamped between `10ms` and `60,000ms`.
