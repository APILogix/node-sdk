/**
 * Pino Logging Integration for LynkTrace Telemetry.
 *
 * Provides:
 * 1. `createPinoStream()`: A high-throughput Writable destination stream for Pino.
 * 2. `pinoTraceMixin()`: Fast zero-overhead mixin for automatic trace and span ID correlation.
 *
 * Usage:
 *   import pino from 'pino'
 *   import { createPinoStream, pinoTraceMixin } from '@lynktrace/node'
 *
 *   const logger = pino({
 *     mixin: pinoTraceMixin,
 *   }, pino.multistream([
 *     { stream: process.stdout },
 *     { stream: createPinoStream() }
 *   ]))
 */
import { Writable } from 'node:stream';
export interface LynkTracePinoOptions {
    /** Minimum severity level to ingest */
    level?: string;
}
/**
 * Pino mixin function for automatic trace correlation.
 * Injects `trace_id` and `span_id` directly into Pino structured log records.
 */
export declare function pinoTraceMixin(): Record<string, string>;
export declare class LynkTracePinoStream extends Writable {
    constructor(_options?: LynkTracePinoOptions);
    _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void;
}
export declare function createPinoStream(options?: LynkTracePinoOptions): LynkTracePinoStream;
