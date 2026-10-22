/**
 * Sequelize Instrumentation — auto-instrumentation for Sequelize ORM.
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resolveModuleSafe, applyIdempotentPatch, sanitizeQueryStatement } from './safe-wrapper.js';
const SEQUELIZE_GUARD = Symbol.for('pulse-sdk.patch.sequelize');
export function createSequelizeInstrumentation(enabled) {
    if (!enabled)
        return null;
    const seqModule = resolveModuleSafe('sequelize');
    if (!seqModule)
        return null;
    const Sequelize = seqModule.Sequelize ?? seqModule.default?.Sequelize;
    if (!Sequelize || !Sequelize.prototype || typeof Sequelize.prototype.query !== 'function') {
        return null;
    }
    const origQuery = Sequelize.prototype.query;
    let active = true;
    applyIdempotentPatch(SEQUELIZE_GUARD, () => {
        Sequelize.prototype.query = function pulseSequelizeQuery(sql, options, ...rest) {
            if (!active)
                return origQuery.apply(this, [sql, options, ...rest]);
            const tracer = trace.getTracer('@lynktrace/node-sequelize');
            const rawSql = typeof sql === 'string' ? sql : sql?.query ?? '';
            const statement = sanitizeQueryStatement(rawSql, 2048);
            const span = tracer.startSpan('sequelize.query', {
                kind: SpanKind.CLIENT,
                attributes: {
                    'db.system': 'sequelize',
                    'db.statement': statement,
                    'db.sequelize.dialect': this.getDialect?.() ?? 'unknown',
                },
            });
            const promise = origQuery.apply(this, [sql, options, ...rest]);
            if (promise && typeof promise.then === 'function') {
                return promise.then((res) => {
                    try {
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                    }
                    catch { }
                    return res;
                }, (err) => {
                    try {
                        span.recordException(err instanceof Error ? err : new Error(String(err)));
                        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) });
                        span.end();
                    }
                    catch { }
                    throw err;
                });
            }
            span.end();
            return promise;
        };
        return () => {
            Sequelize.prototype.query = origQuery;
        };
    });
    return {
        enable: () => { active = true; },
        disable: () => { active = false; },
        teardown: () => {
            active = false;
            Sequelize.prototype.query = origQuery;
        },
    };
}
