import type { Attributes } from '@opentelemetry/api'
import { startSpan, withSpan, withSpanSync } from './tracer.js'
import type { PulseSpan, SpanOptions } from './span.js'

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
}

export function startDbSpan(options: DbSpanOptions): PulseSpan {
    return startSpan(dbSpanName(options), toSpanOptions(options))
}

export async function withDbSpan<T>(options: DbSpanOptions, fn: (span: PulseSpan) => T | Promise<T>): Promise<T> {
    return withSpan(dbSpanName(options), toSpanOptions(options), fn)
}

export function withDbSpanSync<T>(options: DbSpanOptions, fn: (span: PulseSpan) => T): T {
    return withSpanSync(dbSpanName(options), toSpanOptions(options), fn)
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

function dbSpanName(options: DbSpanOptions): string {
    if (options.name) return options.name
    const target = options.table || options.collection || options.database
    return target ? `${options.system}.${options.operation} ${target}` : `${options.system}.${options.operation}`
}
