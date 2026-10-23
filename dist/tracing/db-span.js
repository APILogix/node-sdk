import { startSpan, withSpan, withSpanSync } from './tracer.js';
import { ConfigManager } from '../core/config-manager.js';
function getSlowQueryThreshold(options) {
    if (options.slowQueryThresholdMs !== undefined) {
        return options.slowQueryThresholdMs;
    }
    try {
        const remoteThreshold = ConfigManager.getCurrent()?.getConfigOrNull()?.tracing?.slowQueryThresholdMs;
        if (remoteThreshold !== undefined)
            return remoteThreshold;
    }
    catch { }
    return 100;
}
export function startDbSpan(options) {
    return startSpan(getDbSpanName(options), toSpanOptions(options));
}
export async function withDbSpan(options, fn) {
    const thresholdMs = getSlowQueryThreshold(options);
    const start = Date.now();
    return withSpan(getDbSpanName(options), toSpanOptions(options), async (span) => {
        try {
            const result = await fn(span);
            const durationMs = Date.now() - start;
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true);
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs);
            }
            return result;
        }
        catch (err) {
            const durationMs = Date.now() - start;
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true);
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs);
            }
            throw err;
        }
    });
}
export function withDbSpanSync(options, fn) {
    const thresholdMs = getSlowQueryThreshold(options);
    const start = Date.now();
    return withSpanSync(getDbSpanName(options), toSpanOptions(options), (span) => {
        try {
            const result = fn(span);
            const durationMs = Date.now() - start;
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true);
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs);
            }
            return result;
        }
        catch (err) {
            const durationMs = Date.now() - start;
            if (durationMs >= thresholdMs) {
                span.setAttribute('db.slow_query', true);
                span.setAttribute('db.slow_query_threshold_ms', thresholdMs);
            }
            throw err;
        }
    });
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
function getDbSpanName(options) {
    if (options.name)
        return options.name;
    const target = options.table || options.collection || options.database;
    return target ? `${options.system}.${options.operation} ${target}` : `${options.system}.${options.operation}`;
}
