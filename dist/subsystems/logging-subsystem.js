/**
 * Structured logging subsystem. Remote config owns whether logging exists;
 * local constants define implementation-only console and size behavior.
 */
import { LOGGING_DEFAULTS } from '../constants/internal-defaults.js';
import { getLogger } from '../utils/logger.js';
import { getRequestContext, getSpanId, getTraceId } from '../core/context.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
import { isSdkConsoleBypass } from '../utils/sdk-console.js';
const WRAPPER_MARKER = Symbol.for('pulse-sdk.logging-subsystem.wrapper');
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
    captureLog(level, message, args) {
        if (this.destroyed || !this.config.enabled || !EntitlementGate.isAllowed('logging') || !this.isLevelAllowed(level))
            return;
        const event = {
            type: 'log',
            level,
            message: this.truncateMessage(message),
            timestamp: Date.now(),
            args: args?.length ? this.scrubLogArgs(args.slice(0, 10)) : undefined,
            requestId: getRequestContext()?.requestId,
            traceId: getTraceId(),
            spanId: getSpanId(),
            metadata: this.metadata,
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
    scrubLogArgs(args) {
        const scrubber = SecurityScrubber.getInstance();
        if (!scrubber)
            return [];
        return args.map(arg => scrubber.scrubValue(arg));
    }
    isLevelAllowed(level) {
        return this.config.levels.includes(level);
    }
    truncateMessage(message) {
        if (message.length <= this.config.maxLogSize)
            return message;
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
                logger.warn(`[LoggingSubsystem] console.${level} is already wrapped by Pulse telemetry; skipping install`);
                continue;
            }
            const original = current.bind(console);
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
                        const scrubbedArgs = this.scrubLogArgs(args);
                        const message = scrubbedArgs
                            .map(value => typeof value === 'string' ? value : safeStringify(value))
                            .join(' ');
                        this.captureLog(mappedLevel, message, scrubbedArgs);
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
    return fn[WRAPPER_MARKER] === true;
}
function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch (error) {
        return error instanceof TypeError && error.message.toLowerCase().includes('circular')
            ? '[Circular]'
            : '[Unserializable]';
    }
}
