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
import type { RemoteConfigResponse } from '../types/config.js';
import type { LogEvent, EventMetadata } from '../types/event.js';
type LogEmitter = (event: LogEvent) => void;
/**
 * Token bucket rate limiter for application log streams.
 * Prevents log loops / storms from choking CPU or exhausting memory.
 */
export declare class LogRateLimiter {
    private tokens;
    private readonly capacity;
    private readonly refillRatePerMs;
    private lastRefill;
    constructor(capacity?: number, refillPerSecond?: number);
    tryConsume(count?: number): boolean;
    reset(): void;
}
export declare class LoggingSubsystem {
    private static instance;
    private static captureReentry;
    private config;
    private readonly emitter;
    private metadata;
    private readonly originals;
    private readonly wrappers;
    private intercepted;
    private destroyed;
    private readonly rateLimiter;
    private rateLimitDrops;
    private constructor();
    static initialize(config: Readonly<RemoteConfigResponse>, emitter: LogEmitter, metadata: EventMetadata): LoggingSubsystem;
    static getInstance(): LoggingSubsystem | null;
    updateMetadata(metadata: EventMetadata): void;
    start(): void;
    stop(): void;
    captureLog(level: string, message: string, args?: readonly unknown[], loggerSource?: string, attributes?: Record<string, unknown>): void;
    /** Apply a validated complete snapshot selected by ConfigManager. */
    handleConfigChange(config: Readonly<RemoteConfigResponse>): void;
    getRateLimitDrops(): number;
    resetRateLimiter(): void;
    private scrubLogArgs;
    private isLevelAllowed;
    private truncateMessage;
    private installInterceptors;
    private removeInterceptors;
    destroy(): void;
    static reset(): void;
}
export {};
