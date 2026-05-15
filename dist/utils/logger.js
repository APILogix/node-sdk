/**
 * SDK Logger — Sentry-style debug logging.
 *
 * When `debug: true` is set in SDK options:
 *   - All SDK internal messages are printed via console.log/console.warn/console.error
 *   - Structured context is JSON-stringified and printed alongside
 *
 * When `debug: false` (default):
 *   - Only warnings and errors are printed
 *   - Debug/info messages are silenced for zero noise in production
 *
 * PII redaction is always applied regardless of debug mode.
 */
import { SDKError } from '../core/errors.js';
// ─── Configuration ──────────────────────────────────────────────────────────
let debugMode = false;
let logPrefix = 'Pulse';
/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export function setDebugMode(enabled) {
    debugMode = enabled;
}
/**
 * Set the log prefix (defaults to 'Pulse').
 */
export function setLogPrefix(prefix) {
    logPrefix = prefix;
}
// ─── Redaction ──────────────────────────────────────────────────────────────
const SENSITIVE_KEY_PATTERN = /api[-_]?key|api[-_]?secret|authorization|cookie|token|password|secret|credential/i;
export function redact(value, depth = 0) {
    // Prevent infinite recursion on deeply nested objects
    if (depth > 10)
        return '[max depth]';
    if (typeof value === 'string') {
        return redactString(value);
    }
    if (Array.isArray(value)) {
        return value.map(item => redact(item, depth + 1));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Error) {
        if (value instanceof SDKError) {
            return {
                name: value.name,
                message: value.message,
                code: value.code,
                context: redact(value.context, depth + 1),
                stack: value.stack,
            };
        }
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    const redacted = {};
    for (const [key, nestedValue] of Object.entries(value)) {
        redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : redact(nestedValue, depth + 1);
    }
    return redacted;
}
function redactString(value) {
    return value
        .replace(/authorization=Bearer\s+([^&\s]+)/gi, 'authorization=Bearer [REDACTED]')
        .replace(/(api[-_]?key|token|authorization|password|secret)=([^&\s]+)/gi, '$1=[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
}
// ─── Formatting ─────────────────────────────────────────────────────────────
function formatContext(context) {
    if (!context || Object.keys(context).length === 0)
        return '';
    try {
        const safe = redact(context);
        return ' ' + JSON.stringify(safe);
    }
    catch {
        return ' [unserializable context]';
    }
}
// ─── Console Logger (Sentry-style) ─────────────────────────────────────────
export const consoleLogger = {
    debug(message, context) {
        if (!debugMode)
            return;
        console.log(`[${logPrefix}] DEBUG: ${message}${formatContext(context)}`);
    },
    info(message, context) {
        if (!debugMode)
            return;
        console.log(`[${logPrefix}] INFO: ${message}${formatContext(context)}`);
    },
    warn(message, context) {
        // Warnings always print — they indicate potential issues
        console.warn(`[${logPrefix}] WARN: ${message}${formatContext(context)}`);
    },
    error(message, context) {
        // Errors always print — they indicate real failures
        console.error(`[${logPrefix}] ERROR: ${message}${formatContext(context)}`);
    },
};
// ─── Active Logger Management ───────────────────────────────────────────────
let activeLogger = consoleLogger;
/**
 * Replace the active logger with a custom implementation.
 * Pass undefined/null to restore the default console logger.
 */
export function setLogger(logger) {
    activeLogger = logger ?? consoleLogger;
}
/**
 * Get the active logger instance.
 */
export function getLogger() {
    return activeLogger;
}
//# sourceMappingURL=logger.js.map