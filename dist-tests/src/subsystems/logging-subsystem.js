/**
 * LoggingSubsystem — captures console.log/warn/error/info and explicit log calls.
 *
 * Behavior:
 * - Intercepts console methods based on logging.captureConsole config.
 * - Only captures configured log levels (logging.levels array).
 * - Truncates messages to logging.maxLogSize bytes.
 * - Routes LogEvent objects to the transport layer via the provided emit callback.
 * - Respects killswitch: disableLogs → detach interceptors, drain buffer.
 * - Restores original console methods on teardown.
 */
import { getLogger } from '../utils/logger.js';
export class LoggingSubsystem {
    static instance = null;
    config;
    emitter;
    metadata;
    /** Stashed original console methods — restored on teardown. */
    originals = new Map();
    intercepted = false;
    destroyed = false;
    constructor(config, emitter, metadata) {
        this.config = { ...config };
        this.emitter = emitter;
        this.metadata = metadata;
    }
    static initialize(config, emitter, metadata) {
        if (LoggingSubsystem.instance) {
            LoggingSubsystem.instance.destroy();
        }
        LoggingSubsystem.instance = new LoggingSubsystem(config, emitter, metadata);
        return LoggingSubsystem.instance;
    }
    static getInstance() {
        return LoggingSubsystem.instance;
    }
    /** Start intercepting console methods. */
    start() {
        if (this.intercepted || this.destroyed)
            return;
        if (!this.config.enabled)
            return;
        if (this.config.captureConsole) {
            this.installInterceptors();
        }
        getLogger().info('[LoggingSubsystem] Started');
    }
    /** Stop intercepting and restore original console methods. */
    stop() {
        this.removeInterceptors();
        getLogger().info('[LoggingSubsystem] Stopped');
    }
    /** Explicitly capture a log event. */
    captureLog(level, message, args) {
        if (this.destroyed || !this.config.enabled)
            return;
        if (!this.isLevelAllowed(level))
            return;
        const truncated = this.truncateMessage(message);
        const event = {
            type: 'log',
            level,
            message: truncated,
            timestamp: Date.now(),
            args: args?.length ? args.slice(0, 10) : undefined,
            metadata: this.metadata,
        };
        this.emitter(event);
    }
    /** Handle config change — hot-swap logging config. */
    handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        const newLogging = newConfig.logging;
        const oldEnabled = this.config.enabled && this.config.captureConsole;
        const newEnabled = newLogging.enabled && newLogging.captureConsole;
        this.config = { ...newLogging };
        if (!oldEnabled && newEnabled) {
            this.installInterceptors();
        }
        else if (oldEnabled && !newEnabled) {
            this.removeInterceptors();
        }
    }
    // ─── Private ──────────────────────────────────────────────────────────────
    isLevelAllowed(level) {
        return this.config.levels.includes(level);
    }
    truncateMessage(message) {
        if (message.length <= this.config.maxLogSize)
            return message;
        return message.slice(0, this.config.maxLogSize) + '… [truncated]';
    }
    installInterceptors() {
        if (this.intercepted)
            return;
        const levels = ['log', 'info', 'warn', 'error', 'debug'];
        for (const level of levels) {
            const original = console[level];
            if (typeof original !== 'function')
                continue;
            this.originals.set(level, original.bind(console));
            console[level] = (...args) => {
                // Always call the original first
                original.apply(console, args);
                // Capture if level is allowed
                const mappedLevel = level === 'log' ? 'info' : level;
                if (this.isLevelAllowed(mappedLevel) && !this.destroyed) {
                    try {
                        const message = args
                            .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
                            .join(' ');
                        this.captureLog(mappedLevel, message, args);
                    }
                    catch {
                        // Never throw in console interceptor
                    }
                }
            };
        }
        this.intercepted = true;
    }
    removeInterceptors() {
        if (!this.intercepted)
            return;
        for (const [level, original] of this.originals) {
            ;
            console[level] = original;
        }
        this.originals.clear();
        this.intercepted = false;
    }
    destroy() {
        this.stop();
        this.destroyed = true;
        LoggingSubsystem.instance = null;
    }
    static reset() {
        if (LoggingSubsystem.instance) {
            LoggingSubsystem.instance.destroy();
        }
    }
}
