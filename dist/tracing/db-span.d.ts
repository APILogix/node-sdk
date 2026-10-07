import type { Attributes } from '@opentelemetry/api';
import type { PulseSpan, SpanOptions } from './span.js';
export type DbSystem = 'postgresql' | 'mysql' | 'mongodb' | 'redis' | 'prisma' | string;
export interface DbSpanOptions {
    readonly system: DbSystem;
    readonly operation: string;
    readonly name?: string | undefined;
    readonly database?: string | undefined;
    readonly table?: string | undefined;
    readonly collection?: string | undefined;
    readonly statement?: string | undefined;
    readonly attributes?: Attributes | undefined;
    readonly parent?: SpanOptions['parent'] | undefined;
    readonly startTime?: SpanOptions['startTime'] | undefined;
    readonly links?: SpanOptions['links'] | undefined;
    readonly timeoutMs?: number | undefined;
    readonly slowQueryThresholdMs?: number | undefined;
}
export declare function startDbSpan(options: DbSpanOptions): PulseSpan;
export declare function withDbSpan<T>(options: DbSpanOptions, fn: (span: PulseSpan) => T | Promise<T>): Promise<T>;
export declare function withDbSpanSync<T>(options: DbSpanOptions, fn: (span: PulseSpan) => T): T;
