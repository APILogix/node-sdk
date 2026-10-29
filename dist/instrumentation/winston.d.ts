/**
 * Winston Logging Integration for LynkTrace Telemetry.
 *
 * Provides an enterprise Winston transport that automatically:
 * 1. Correlates active OpenTelemetry traceId and spanId into the Winston info object.
 * 2. Bridges Winston logs into the LynkTrace LoggingSubsystem non-blockingly.
 * 3. Does not block the host application event loop or allocate unbounded memory.
 *
 * Usage:
 *   import winston from 'winston'
 *   import { createWinstonTransport } from '@lynktrace/node'
 *
 *   const logger = winston.createLogger({
 *     transports: [
 *       new winston.transports.Console(),
 *       createWinstonTransport({ level: 'info' })
 *     ]
 *   })
 */
import { Writable } from 'node:stream';
export interface LynkTraceWinstonOptions {
    /** Minimum log level to capture (default: 'info') */
    level?: string;
    /** Whether transport is silent / disabled */
    silent?: boolean;
}
export declare class LynkTraceWinstonTransport extends Writable {
    readonly name = "lynktrace";
    level: string;
    silent: boolean;
    constructor(options?: LynkTraceWinstonOptions);
    log(info: any, next?: () => void): void;
    _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void;
}
export declare function createWinstonTransport(options?: LynkTraceWinstonOptions): LynkTraceWinstonTransport;
