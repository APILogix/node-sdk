import type { Attributes } from '@opentelemetry/api'
import { startSpan, withSpan, withSpanSync } from './tracer.js'
import type { LynkTraceSpan, PulseSpan, SpanOptions } from './span.js'

export type DbSystem = 'postgresql' | 'mysql' | 'mongodb' | 'redis' | 'prisma' | string

export interface DbSpanOptions {
    readonly system: DbSystem
    readonly operation: string
    readonly name?: string | undefined
    readonly database?: string | undefined
    readonly table?: string | undefined
    readonly collection?: string | undefined
    readonly statement?: string | undefined
    readonly attributes?: Attributes | undefined
    readonly parent?: SpanOptions['parent'] | undefined
    readonly startTime?: SpanOptions['startTime'] | undefined
    readonly links?: SpanOptions['links'] | undefined
    readonly timeoutMs?: number | undefined
    readonly slowQueryThresholdMs?: number | undefined
}

export function startDbSpan(options: DbSpanOptions): LynkTraceSpan {
    return startSpan(getDbSpanName(options), toSpanOptions(options))
}

export async function withDbSpan<T>(options: DbSpanOptions, fn: (span: LynkTraceSpan) => T | Promise<T>): Promise<T> {
    const thresholdMs = options.slowQueryThresholdMs ?? 100
    const start = Date.now()
    return withSpan(getDbSpanName(options), toSpanOptions(options), async (span) => {
        try {
            const result = await fn(span)
            const durationMs = Date.now() - start
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true)
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs)
            }
            return result
        } catch (err) {
            const durationMs = Date.now() - start
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true)
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs)
            }
            throw err
        }
    })
}

export function withDbSpanSync<T>(options: DbSpanOptions, fn: (span: LynkTraceSpan) => T): T {
    const thresholdMs = options.slowQueryThresholdMs ?? 100
    const start = Date.now()
    return withSpanSync(getDbSpanName(options), toSpanOptions(options), (span) => {
        try {
            const result = fn(span)
            const durationMs = Date.now() - start
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true)
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs)
            }
            return result
        } catch (err) {
            const durationMs = Date.now() - start
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true)
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs)
            }
            throw err
        }
    })
}

function toSpanOptions(options: DbSpanOptions): SpanOptions {
    const attributes: Attributes = {
        ...(options.attributes ?? {}),
        'db.system': options.system,
        'db.operation': options.operation,
    }

    if (options.database !== undefined) attributes['db.name'] = options.database
    if (options.table !== undefined) attributes['db.sql.table'] = options.table
    if (options.collection !== undefined) attributes['db.collection'] = options.collection
    if (options.statement !== undefined) attributes['db.statement'] = options.statement

    return {
        kind: 'client',
        attributes,
        ...(options.parent !== undefined ? { parent: options.parent } : {}),
        ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
        ...(options.links !== undefined ? { links: options.links } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }
}

function getDbSpanName(options: DbSpanOptions): string {
    if (options.name) return options.name
    const target = options.table || options.collection || options.database
    return target ? `${options.system}.${options.operation} ${target}` : `${options.system}.${options.operation}`
}
