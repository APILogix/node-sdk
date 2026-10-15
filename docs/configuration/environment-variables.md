# Environment Variables & Discovery

## 1. Pure In-Memory Configuration (Zero Disk I/O)

To ensure zero synchronous disk I/O and optimal cold-start performance, `.env` file loading is permanently removed from the SDK runtime. The backend control plane URL is hardcoded directly (`BACKEND_BASE_URL = 'https://api.lynktrace.com'`). Runtime environment variables present in `process.env` (e.g. injected via Docker, Kubernetes, or cloud hosts) are read directly in-memory without filesystem access.

---

## 2. Environment Variables Reference

| Variable | Description | Default Fallback |
|---|---|---|
| **`PULSE_API_KEY`** | Pulse APM Project API Key. | None (Required) |
| **`LYNKTRACE_ENDPOINT`** | Custom control-plane URL override. | `https://api.lynktrace.com` |
| **`PULSE_ENDPOINT`** | Custom ingestion and control-plane URL. | `https://api.lynktrace.com` |
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
