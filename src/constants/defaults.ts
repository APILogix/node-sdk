/** Production control-plane origin and hard validation safety bounds. */

/** Production SaaS API origin used when neither baseUrl nor SDK_BASE_URL is provided. */
export const DEFAULT_API_BASE_URL = 'https://api.veyontix.com'

/** Resolve the control-plane origin; this selects an endpoint, not runtime policy. */
export function resolveApiBaseUrl(baseUrl?: string): string {
  return baseUrl ?? process.env['SDK_BASE_URL'] ?? DEFAULT_API_BASE_URL
}

/**
 * Absolute bounds for complete backend snapshots. Values outside these bounds
 * make the entire snapshot invalid; they are never clamped or merged.
 */
export const SAFETY_CEILINGS = Object.freeze({
  maxSpansPerTrace: 5_000,
  maxSpanAttributes: 500,
  maxAttributeLength: 16 * 1024,
  maxPayloadSize: 4 * 1024 * 1024,
  maxQueueSize: 100_000,
  maxMemoryMb: 1_024,
  batchSize: 5_000,
  flushIntervalMs: 5 * 60 * 1_000,
  timeoutMs: 60_000,
  retryMaxRetries: 10,
  retryBaseDelayMs: 30_000,
} as const)
