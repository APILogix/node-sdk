/**
 * Message capture — captures arbitrary text messages with severity.
 * Similar to Sentry's captureMessage().
 */
import type { SeverityLevel } from '../types/severity.js';
/**
 * Capture a text message at the given severity level.
 *
 * @param message - The message text
 * @param severity - Severity level (default: 'info')
 * @param context - Additional context data
 */
export declare function captureMessage(message: string, severity?: SeverityLevel, context?: Record<string, unknown>): void;
//# sourceMappingURL=captureMessage.d.ts.map