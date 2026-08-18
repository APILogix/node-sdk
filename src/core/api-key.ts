import { SDKError } from './errors.js'

/** Validate credentials before they reach an HTTP request. */
export function validateApiKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new SDKError('apiKey is required', 'INVALID_API_KEY')
  }

  // Reject framing/control characters even though control-plane requests put
  // the key in JSON; telemetry requests use the same value in Authorization.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(apiKey)) {
    throw new SDKError('apiKey contains illegal control characters', 'INVALID_API_KEY')
  }
}
