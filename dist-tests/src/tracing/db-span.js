import { startSpan, withSpan, withSpanSync } from './tracer.js';
export function startDbSpan(options) {
    return startSpan(dbSpanName(options), toSpanOptions(options));
}
export async function withDbSpan(options, fn) {
    return withSpan(dbSpanName(options), toSpanOptions(options), fn);
}
export function withDbSpanSync(options, fn) {
    return withSpanSync(dbSpanName(options), toSpanOptions(options), fn);
}
function toSpanOptions(options) {
    const attributes = {
        ...(options.attributes ?? {}),
        'db.system': options.system,
        'db.operation': options.operation,
    };
    if (options.database !== undefined)
        attributes['db.name'] = options.database;
    if (options.table !== undefined)
        attributes['db.sql.table'] = options.table;
    if (options.collection !== undefined)
        attributes['db.collection'] = options.collection;
    if (options.statement !== undefined)
        attributes['db.statement'] = options.statement;
    return {
        kind: 'client',
        attributes,
        ...(options.parent !== undefined ? { parent: options.parent } : {}),
        ...(options.startTime !== undefined ? { startTime: options.startTime } : {}),
        ...(options.links !== undefined ? { links: options.links } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
}
function dbSpanName(options) {
    if (options.name)
        return options.name;
    const target = options.table || options.collection || options.database;
    return target ? `${options.system}.${options.operation} ${target}` : `${options.system}.${options.operation}`;
}
