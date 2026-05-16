/**
 * Base URL must be provided via SDK_BASE_URL env var or `baseUrl` in SDK config.
 * Empty string signals "not configured" — init will throw a clear error.
 */
export const DEFAULT_BASE_URL = process.env.SDK_BASE_URL || "";
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;
export const DEFAULT_MAX_QUEUE_SIZE = 1000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;
//# sourceMappingURL=defaults.js.map