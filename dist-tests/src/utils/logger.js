/**
 * SDK Logger — Sentry-style debug logging.
 *
 * Output strategy (post v3 fix for the console-interception feedback loop):
 *   The SDK never writes through `console.log/info/warn/error`. Those
 *   slots are intercepted by `LoggingSubsystem.installInterceptors()` to
 *   capture user logs as `log` events; if the SDK itself wrote there,
 *   every internal `logger.debug/info/warn/error` call would create a
 *   `log` event, which inside the pipeline produces more debug output,
 *   producing more `log` events — a runaway storm we observed at
 *   thousands of events per second under `setDebugMode(true)`.
 *
 *   Both loggers below now write directly to `process.stdout` (info /
 *   debug) or `process.stderr` (warn / error). The LoggingSubsystem's
 *   wrapper never sees these writes, so the feedback loop is broken at
 *   the source.
 *
 *   PII redaction is always applied regardless of debug mode.
 */
import { SDKError } from '../core/errors.js';
import { Severity, doesSeverityMeetThreshold } from '../types/severity.js';
import { trace as otelTrace } from '@opentelemetry/api';
// ─── Configuration ──────────────────────────────────────────────────────────
let debugMode = false;
let logPrefix = 'Telemetry';
let minimumLogLevel = Severity.Info;
/**
 * Enable or disable debug logging globally.
 * Called during SDK initialization based on `options.debug`.
 */
export function setDebugMode(enabled) {
    debugMode = enabled;
    minimumLogLevel = enabled ? Severity.Debug : Severity.Info;
}
/**
 * Set the minimum SDK internal log level.
 */
export function setLogLevel(level) {
    minimumLogLevel = level;
}
/**
 * Set the log prefix (defaults to 'Telemetry').
 */
export function setLogPrefix(prefix) {
    logPrefix = prefix;
}
// ─── Redaction ──────────────────────────────────────────────────────────────
const SENSITIVE_KEY_PATTERN = /api[-_]?key|api[-_]?secret|authorization|cookie|token|password|secret|credential/i;
export function redact(value, depth = 0, seen = new WeakSet()) {
    if (depth > 8)
        return '[max depth]';
    if (typeof value === 'string')
        return redactString(value);
    if (!value || typeof value !== 'object')
        return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `[Buffer:${value.byteLength}b]`;
    }
    if (value instanceof Date)
        return value.toISOString();
    if (value instanceof RegExp)
        return value.toString();
    if (seen.has(value))
        return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
        const maxItems = Math.min(value.length, 50);
        const out = new Array(maxItems);
        for (let i = 0; i < maxItems; i++) {
            out[i] = redact(value[i], depth + 1, seen);
        }
        if (value.length > maxItems)
            out.push(`...(+${value.length - maxItems} items)`);
        seen.delete(value);
        return out;
    }
    if (value instanceof Error) {
        const errObj = value instanceof SDKError
            ? {
                name: value.name,
                message: redactString(value.message),
                code: value.code,
                context: redact(value.context, depth + 1, seen),
                stack: value.stack,
            }
            : {
                name: value.name,
                message: redactString(value.message),
                stack: value.stack,
            };
        seen.delete(value);
        return errObj;
    }
    const redacted = {};
    const keys = Object.keys(value);
    const limit = Math.min(keys.length, 50);
    for (let i = 0; i < limit; i++) {
        const key = keys[i];
        const nestedValue = value[key];
        redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : redact(nestedValue, depth + 1, seen);
    }
    if (keys.length > limit) {
        redacted['__truncatedKeys'] = keys.length - limit;
    }
    seen.delete(value);
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
// ─── Direct stream writers ─────────────────────────────────────────────────
//
// We intentionally do NOT use console.log / console.error here. The
// LoggingSubsystem patches those slots to capture user telemetry, and any
// SDK-originated write would be re-captured as a `log` event, which would
// itself trigger more debug logs, ad infinitum.
//
// `process.stdout.write` / `process.stderr.write` are unaffected by the
// console interception because the wrapper only replaces `console.*`
// methods, not the underlying streams.
function writeStdout(line) {
    // Best-effort. If stdout is detached (e.g., daemonised process), swallow
    // silently rather than throwing — the SDK should never crash the host
    // because we couldn't print a log.
    try {
        process.stdout.write(line + '\n');
    }
    catch {
        /* stdout closed — nothing we can do */
    }
}
function writeStderr(line) {
    try {
        process.stderr.write(line + '\n');
    }
    catch {
        /* stderr closed — nothing we can do */
    }
}
function stripPrefix(message) {
    if (message.startsWith(`[${logPrefix}]`)) {
        return message.slice(logPrefix.length + 2).trim();
    }
    return message.replace(/^\[(LynkTrace|Pulse|Telemetry|APM|SDK)\]\s*/i, '').trim();
}
// ─── Console Logger (Sentry-style) ─────────────────────────────────────────
export const consoleLogger = {
    debug(message, context) {
        if (!doesSeverityMeetThreshold(Severity.Debug, minimumLogLevel))
            return;
        writeStdout(`[${logPrefix}] DEBUG: ${stripPrefix(message)}${formatContext(context)}`);
    },
    info(message, context) {
        if (!doesSeverityMeetThreshold(Severity.Info, minimumLogLevel))
            return;
        writeStdout(`[${logPrefix}] INFO: ${stripPrefix(message)}${formatContext(context)}`);
    },
    warn(message, context) {
        if (!doesSeverityMeetThreshold(Severity.Warning, minimumLogLevel))
            return;
        writeStderr(`[${logPrefix}] WARN: ${stripPrefix(message)}${formatContext(context)}`);
    },
    error(message, context) {
        if (!doesSeverityMeetThreshold(Severity.Error, minimumLogLevel))
            return;
        writeStderr(`[${logPrefix}] ERROR: ${stripPrefix(message)}${formatContext(context)}`);
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
        if (!doesSeverityMeetThreshold(Severity.Debug, minimumLogLevel))
            return;
        emitJsonLog('debug', message, context);
    },
    info(message, context) {
        if (!doesSeverityMeetThreshold(Severity.Info, minimumLogLevel))
            return;
        emitJsonLog('info', message, context);
    },
    warn(message, context) {
        if (!doesSeverityMeetThreshold(Severity.Warning, minimumLogLevel))
            return;
        emitJsonLog('warn', message, context);
    },
    error(message, context) {
        if (!doesSeverityMeetThreshold(Severity.Error, minimumLogLevel))
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
        message: stripPrefix(message),
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
    const writer = level === 'error' || level === 'warn' ? writeStderr : writeStdout;
    try {
        writer(JSON.stringify(entry));
    }
    catch {
        // Fallback if JSON.stringify fails on the entry itself
        writer(`{"timestamp":"${entry.timestamp}","level":"${level}","message":"${message}","error":"log_serialization_failed"}`);
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
