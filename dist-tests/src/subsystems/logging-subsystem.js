/**
 * Structured logging subsystem. Remote config owns whether logging exists;
 * local constants define implementation-only console, rate limiting, and size behavior.
 *
 * Enterprise Non-Blocking & Low-Memory Guarantees:
 * - Token bucket rate limiter bounds logging throughput and drops floods in O(1) time.
 * - Fast shallow formatting inside console interception avoids blocking the host app thread.
 * - Automatic breadcrumb bridging injects recent application logs into active context
 *   for rich exception and crash correlation.
 * - OpenTelemetry-compliant severity numbers and logger identification.
 */
import { LOGGING_DEFAULTS } from '../constants/internal-defaults.js';
import { getLogger } from '../utils/logger.js';
import { getRequestContext, getSpanId, getTraceId, addBreadcrumb } from '../core/context.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
import { isSdkConsoleBypass } from '../utils/sdk-console.js';
import { Severity } from '../types/severity.js';
const WRAPPER_MARKER = Symbol.for('lynktrace.logging-subsystem.wrapper');
const WRAPPER_MARKER_LEGACY = Symbol.for('pulse-sdk.logging-subsystem.wrapper');
const SEVERITY_NUMBER_MAP = Object.freeze({
    trace: 1,
    debug: 5,
    info: 9,
    warn: 13,
    warning: 13,
    error: 17,
    fatal: 21,
});
/**
 * Token bucket rate limiter for application log streams.
 * Prevents log loops / storms from choking CPU or exhausting memory.
 */
export class LogRateLimiter {
    tokens;
    capacity;
    refillRatePerMs;
    lastRefill;
    constructor(capacity = 1000, refillPerSecond = 500) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillRatePerMs = refillPerSecond / 1000;
        this.lastRefill = Date.now();
    }
    tryConsume(count = 1) {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        if (elapsed > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerMs);
            this.lastRefill = now;
        }
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }
    reset() {
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
    }
}
export class LoggingSubsystem {
    static instance = null;
    static captureReentry = false;
    config;
    emitter;
    metadata;
    originals = new Map();
    wrappers = new Map();
    intercepted = false;
    destroyed = false;
    rateLimiter = new LogRateLimiter(1000, 500);
    rateLimitDrops = 0;
    constructor(config, emitter, metadata) {
        this.config = resolveLoggingConfig(config);
        this.emitter = emitter;
        this.metadata = metadata;
    }
    static initialize(config, emitter, metadata) {
        LoggingSubsystem.instance?.destroy();
        LoggingSubsystem.instance = new LoggingSubsystem(config, emitter, metadata);
        return LoggingSubsystem.instance;
    }
    static getInstance() {
        return LoggingSubsystem.instance;
    }
    updateMetadata(metadata) {
        this.metadata = metadata;
    }
    start() {
        if (this.intercepted || this.destroyed || !this.config.enabled)
            return;
        if (this.config.captureConsole)
            this.installInterceptors();
        getLogger().info('[LoggingSubsystem] Started');
    }
    stop() {
        this.removeInterceptors();
        getLogger().info('[LoggingSubsystem] Stopped');
    }
    captureLog(level, message, args, loggerSource = 'custom', attributes) {
        if (this.destroyed || !this.config.enabled || !EntitlementGate.isAllowed('logging') || !this.isLevelAllowed(level))
            return;
        // Token-bucket rate limiting (O(1), zero allocation)
        if (!this.rateLimiter.tryConsume(1)) {
            this.rateLimitDrops++;
            return;
        }
        const truncatedMsg = this.truncateMessage(message);
        const normalizedLevel = level.toLowerCase();
        // Bridge to contextual breadcrumbs for exception enrichment
        try {
            const bLevel = (normalizedLevel === 'warn' || normalizedLevel === 'warning')
                ? Severity.Warning
                : (normalizedLevel === 'error' || normalizedLevel === 'fatal')
                    ? Severity.Error
                    : normalizedLevel === 'debug' || normalizedLevel === 'trace'
                        ? Severity.Debug
                        : Severity.Info;
            addBreadcrumb({
                category: loggerSource || 'log',
                message: truncatedMsg,
                level: bLevel,
                ...(attributes && Object.keys(attributes).length > 0 ? { data: attributes } : {}),
            });
        }
        catch {
            // Breadcrumb capture must never throw into application logic
        }
        const severityNumber = SEVERITY_NUMBER_MAP[normalizedLevel] ?? 9;
        const event = {
            type: 'log',
            level: normalizedLevel,
            message: truncatedMsg,
            timestamp: Date.now(),
            requestId: getRequestContext()?.requestId,
            traceId: getTraceId(),
            spanId: getSpanId(),
            metadata: this.metadata,
            logger: loggerSource,
            severityNumber,
            ...(args?.length ? { args: this.scrubLogArgs(args.slice(0, 10)) } : {}),
            ...(attributes ? { attributes } : {}),
        };
        this.emitter(event);
    }
    /** Apply a validated complete snapshot selected by ConfigManager. */
    handleConfigChange(config) {
        if (this.destroyed)
            return;
        const previous = this.config;
        const current = resolveLoggingConfig(config);
        const wasIntercepting = previous.enabled && previous.captureConsole;
        const shouldIntercept = current.enabled && current.captureConsole;
        this.config = current;
        if (!wasIntercepting && shouldIntercept)
            this.installInterceptors();
        else if (wasIntercepting && !shouldIntercept)
            this.removeInterceptors();
    }
    getRateLimitDrops() {
        return this.rateLimitDrops;
    }
    resetRateLimiter() {
        this.rateLimiter.reset();
        this.rateLimitDrops = 0;
    }
    scrubLogArgs(args) {
        const scrubber = SecurityScrubber.getInstance();
        if (!scrubber)
            return args;
        return args.map(arg => scrubber.scrubValue(arg));
    }
    isLevelAllowed(level) {
        const norm = level.toLowerCase();
        return this.config.levels.includes(norm) || (norm === 'warning' && this.config.levels.includes('warn'));
    }
    truncateMessage(message) {
        if (!message || message.length <= this.config.maxLogSize)
            return message || '';
        return `${message.slice(0, this.config.maxLogSize)}… [truncated]`;
    }
    installInterceptors() {
        if (this.intercepted || this.destroyed || !this.config.enabled)
            return;
        const levels = ['log', 'info', 'warn', 'error', 'debug'];
        const consoleMethods = console;
        const logger = getLogger();
        for (const level of levels) {
            const current = consoleMethods[level];
            if (typeof current !== 'function')
                continue;
            if (isMarkedWrapper(current)) {
                logger.warn(`[LoggingSubsystem] console.${level} is already wrapped by LynkTrace telemetry; skipping install`);
                continue;
            }
            // Keep the exact function (not a bound copy) so that restoring it puts
            // back the identical object — other wrappers (e.g. the console.error
            // capture in global-errors) recognise themselves by identity.
            const original = current;
            this.originals.set(level, original);
            const wrapper = (...args) => {
                original.apply(console, args);
                if (args.some(isSdkConsoleBypass))
                    return;
                if (LoggingSubsystem.captureReentry)
                    return;
                LoggingSubsystem.captureReentry = true;
                try {
                    const mappedLevel = level === 'log' ? 'info' : level === 'warn' ? 'warning' : level;
                    if (this.isLevelAllowed(mappedLevel) && !this.destroyed && this.config.enabled) {
                        const shallowArgs = args.length > 0 ? args.slice(0, 10) : undefined;
                        let message;
                        if (args.length === 0) {
                            message = '';
                        }
                        else if (typeof args[0] === 'string') {
                            message = args[0];
                            if (args.length > 1) {
                                message += ' ' + fastFormatArgs(args.slice(1, 4));
                            }
                        }
                        else {
                            message = fastFormatArgs(args.slice(0, 3));
                        }
                        this.captureLog(mappedLevel, message, shallowArgs, 'console');
                    }
                }
                catch {
                    // Console capture must never alter application control flow.
                }
                finally {
                    LoggingSubsystem.captureReentry = false;
                }
            };
            wrapper[WRAPPER_MARKER] = true;
            wrapper[WRAPPER_MARKER_LEGACY] = true;
            this.wrappers.set(level, wrapper);
            consoleMethods[level] = wrapper;
        }
        this.intercepted = true;
    }
    removeInterceptors() {
        if (!this.intercepted)
            return;
        const consoleMethods = console;
        for (const [level, original] of this.originals) {
            if (consoleMethods[level] === this.wrappers.get(level))
                consoleMethods[level] = original;
        }
        this.originals.clear();
        this.wrappers.clear();
        this.intercepted = false;
    }
    destroy() {
        this.stop();
        this.destroyed = true;
        if (LoggingSubsystem.instance === this)
            LoggingSubsystem.instance = null;
    }
    static reset() {
        LoggingSubsystem.instance?.destroy();
    }
}
function resolveLoggingConfig(config) {
    const remoteLogs = config.logs;
    return {
        enabled: remoteLogs?.enabled ?? config.features.logging,
        captureConsole: remoteLogs?.captureConsole ?? LOGGING_DEFAULTS.captureConsole,
        levels: remoteLogs?.levels ?? LOGGING_DEFAULTS.levels,
        maxLogSize: remoteLogs?.maxLogSize ?? LOGGING_DEFAULTS.maxLogSize,
    };
}
function isMarkedWrapper(fn) {
    return fn[WRAPPER_MARKER] === true || fn[WRAPPER_MARKER_LEGACY] === true;
}
/**
 * Fast, non-blocking argument formatter.
 * Avoids deep JSON serialization or complex regex in the hot path.
 */
function fastFormatArgs(args) {
    const parts = [];
    for (let i = 0; i < args.length; i++) {
        const val = args[i];
        if (typeof val === 'string') {
            parts.push(val);
        }
        else if (typeof val === 'number' || typeof val === 'boolean' || val === null || val === undefined) {
            parts.push(String(val));
        }
        else if (val instanceof Error) {
            parts.push(`${val.name}: ${val.message}`);
        }
        else if (typeof val === 'object') {
            try {
                const str = JSON.stringify(val);
                parts.push(str.length > 512 ? str.slice(0, 512) + '...' : str);
            }
            catch {
                parts.push('[Object]');
            }
        }
        else {
            parts.push(String(val));
        }
    }
    return parts.join(' ');
}
