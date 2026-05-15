import { randomUUID } from 'crypto'

/**
 * Generates a cryptographically random UUID v4.
 * Uses Node.js crypto.randomUUID() for secure entropy.
 */
export function generateId(): string {
  return randomUUID()
}

/**
 * Generates a compact 16-character hex ID.
 * Useful for span IDs and short correlation identifiers.
 * Uses the first 16 hex chars of a UUID (64-bit entropy).
 */
export function generateShortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * Validates a UUID v4 string format.
 */
export function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
