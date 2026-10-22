/**
 * safe-wrapper — defensive foundation for auto-instrumentation modules.
 *
 * Provides:
 * - Fail-open module resolution (zero crashes when optional dependencies are missing)
 * - Process-wide idempotent patching guards
 * - Centralized teardown registration
 * - Non-event-blocking bounded string sanitization (< 50µs)
 * - Safe span execution boundaries
 */
import { type Span, type SpanOptions, type Tracer } from '@opentelemetry/api';
/**
 * Safely resolves an optional dependency from the host application's working
 * directory or local module resolution without throwing MODULE_NOT_FOUND.
 */
export declare function resolveModuleSafe(moduleName: string, force?: boolean): any | null;
/**
 * Applies an idempotent patch guarded by a unique global Symbol.
 * Ensures the patch is applied at most once per process and registers
 * its teardown function in the SDK's central teardown registry.
 */
export declare function applyIdempotentPatch(guardSymbol: symbol, patchFn: () => (() => void) | void): boolean;
/**
 * Redacts query strings, parameters, or payloads with guaranteed memory bounds.
 * Never executes slow multi-pass regexes on large inputs.
 */
export declare function sanitizeQueryStatement(query: unknown, maxLength?: number): string;
/**
 * Wraps a synchronous or asynchronous driver operation in a safe OpenTelemetry span.
 * Guarantees that any instrumentation failure never affects host application execution.
 */
export declare function withSafeSpan<T>(tracer: Tracer, name: string, options: SpanOptions, execute: (span: Span) => T): T;
