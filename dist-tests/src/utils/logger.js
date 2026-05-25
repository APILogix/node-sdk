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
import { Severity, severityMeetsThreshold } from '../types/severity.js';
import { trace as otelTrace } from '@opentelemetry/api';
// ─── Configuration ──────────────────────────────────────────────────────────
let debugMode = false;
let logPrefix = 'Pulse';
let minimumLogLevel = Severity.Warning;
/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export function setDebugMode(enabled) {
    debugMode = enabled;
    minimumLogLevel = enabled ? Severity.Debug : Severity.Warning;
}
/**
 * Set the minimum SDK internal log level.
 */
export function setLogLevel(level) {
    minimumLogLevel = level;
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
/**
 * Maximum size for a single serialized log context. Larger payloads are
 * truncated to prevent memory spikes from accidentally-large objects
 * (e.g., a user logging a giant request body or response object).
 */
const MAX_LOG_CONTEXT_BYTES = 16 * 1024; // 16 KB
function formatContext(context) {
    if (!context || Object.keys(context).length === 0)
        return '';
    try {
        const safe = redact(context);
        const serialized = JSON.stringify(safe);
        if (serialized.length > MAX_LOG_CONTEXT_BYTES) {
            const truncated = serialized.slice(0, MAX_LOG_CONTEXT_BYTES);
            return ` ${truncated}...[truncated:${serialized.length}b]`;
        }
        return ' ' + serialized;
    }
    catch {
        return ' [unserializable context]';
    }
}
// ─── Console Logger (Sentry-style) ─────────────────────────────────────────
export const consoleLogger = {
    debug(message, context) {
        if (!severityMeetsThreshold(Severity.Debug, minimumLogLevel))
            return;
        console.log(`[${logPrefix}] DEBUG: ${message}${formatContext(context)}`);
    },
    info(message, context) {
        if (!severityMeetsThreshold(Severity.Info, minimumLogLevel))
            return;
        console.log(`[${logPrefix}] INFO: ${message}${formatContext(context)}`);
    },
    warn(message, context) {
        // Warnings always print — they indicate potential issues
        if (!severityMeetsThreshold(Severity.Warning, minimumLogLevel))
            return;
        console.warn(`[${logPrefix}] WARN: ${message}${formatContext(context)}`);
    },
    error(message, context) {
        // Errors always print — they indicate real failures
        if (!severityMeetsThreshold(Severity.Error, minimumLogLevel))
            return;
        console.error(`[${logPrefix}] ERROR: ${message}${formatContext(context)}`);
    },
};
// ─── Structured JSON Logger (Production-grade) ─────────────────────────────
/**
 * Get active trace context from the OTel API for log correlation.
 * Returns traceId and spanId if a span is active, otherwise undefined.
 */
function getActiveTraceContext() {
    try {
        const activeSpan = otelTrace.getActiveSpan();
        if (activeSpan) {
            const ctx = activeSpan.spanContext();
            return { traceId: ctx.traceId, spanId: ctx.spanId };
        }
    }
    catch {
        // OTel not available or no active span — expected
    }
    return {};
}
/**
 * Structured JSON logger — emits newline-delimited JSON (NDJSON) suitable
 * for production log aggregation systems (ELK, Datadog, CloudWatch, etc.).
 *
 * Every log entry includes:
 * - ISO timestamp
 * - Log level
 * - Message
 * - Active traceId/spanId (if OTel tracing is active)
 * - SDK prefix tag
 * - Redacted structured context
 */
export const jsonLogger = {
    debug(message, context) {
        if (!severityMeetsThreshold(Severity.Debug, minimumLogLevel))
            return;
        emitJsonLog('debug', message, context);
    },
    info(message, context) {
        if (!severityMeetsThreshold(Severity.Info, minimumLogLevel))
            return;
        emitJsonLog('info', message, context);
    },
    warn(message, context) {
        if (!severityMeetsThreshold(Severity.Warning, minimumLogLevel))
            return;
        emitJsonLog('warn', message, context);
    },
    error(message, context) {
        if (!severityMeetsThreshold(Severity.Error, minimumLogLevel))
            return;
        emitJsonLog('error', message, context);
    },
};
function emitJsonLog(level, message, context) {
    const trace = getActiveTraceContext();
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        logger: logPrefix,
        message,
    };
    // Inject trace correlation if available
    if (trace.traceId)
        entry['trace.id'] = trace.traceId;
    if (trace.spanId)
        entry['span.id'] = trace.spanId;
    // Merge redacted context — bounded so a single oversized log entry can't
    // OOM the process.
    if (context && Object.keys(context).length > 0) {
        try {
            const safe = redact(context);
            const serialized = JSON.stringify(safe);
            if (serialized.length > MAX_LOG_CONTEXT_BYTES) {
                entry['context'] = '[truncated]';
                entry['contextSize'] = serialized.length;
            }
            else {
                entry['context'] = safe;
            }
        }
        catch {
            entry['context'] = '[unserializable]';
        }
    }
    const output = level === 'error' || level === 'warn' ? console.error : console.log;
    try {
        output(JSON.stringify(entry));
    }
    catch {
        // Fallback if JSON.stringify fails on the entry itself
        output(`{"timestamp":"${entry.timestamp}","level":"${level}","message":"${message}","error":"log_serialization_failed"}`);
    }
}
let currentLogFormat = 'text';
/**
 * Set the log output format.
 * 'text' = Sentry-style prefixed console output (default, good for dev)
 * 'json' = NDJSON structured output (production, log aggregation)
 */
export function setLogFormat(format) {
    currentLogFormat = format;
    activeLogger = format === 'json' ? jsonLogger : consoleLogger;
}
/**
 * Get the current log format.
 */
export function getLogFormat() {
    return currentLogFormat;
}
// ─── Active Logger Management ───────────────────────────────────────────────
let activeLogger = consoleLogger;
/**
 * Replace the active logger with a custom implementation.
 * Pass undefined/null to restore the default console logger.
 */
export function setLogger(logger) {
    activeLogger = logger ?? (currentLogFormat === 'json' ? jsonLogger : consoleLogger);
}
/**
 * Get the active logger instance.
 */
export function getLogger() {
    return activeLogger;
}
