/**
 * SQLite Instrumentation — auto-instrumentation for better-sqlite3 and sqlite3.
 *
 * Engineered with high-performance monotonic timing (process.hrtime.bigint)
 * to ensure near-zero overhead on synchronous in-memory and embedded SQLite calls.
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resolveModuleSafe, applyIdempotentPatch, sanitizeQueryStatement } from './safe-wrapper.js';
const SQLITE_GUARD = Symbol.for('pulse-sdk.patch.sqlite');
export function createSQLiteInstrumentation(enabled, options, _captureConfig) {
    if (!enabled)
        return null;
    const betterSqlite = resolveModuleSafe('better-sqlite3');
    const sqlite3 = resolveModuleSafe('sqlite3');
    if (!betterSqlite && !sqlite3)
        return null;
    let active = true;
    applyIdempotentPatch(SQLITE_GUARD, () => {
        const unpatches = [];
        // 1. better-sqlite3 synchronous patch
        if (betterSqlite) {
            const DatabaseClass = typeof betterSqlite === 'function' ? betterSqlite : betterSqlite.default;
            if (DatabaseClass?.prototype?.prepare) {
                const origPrepare = DatabaseClass.prototype.prepare;
                DatabaseClass.prototype.prepare = function pulseBetterSqlitePrepare(source, ...prepArgs) {
                    const statement = origPrepare.apply(this, [source, ...prepArgs]);
                    if (!active || !statement)
                        return statement;
                    for (const method of ['run', 'get', 'all']) {
                        const origMethod = statement[method];
                        if (typeof origMethod !== 'function')
                            continue;
                        statement[method] = function pulseBetterSqliteExec(...execArgs) {
                            if (!active)
                                return origMethod.apply(this, execArgs);
                            const tracer = trace.getTracer('@lynktrace/node-sqlite');
                            const startHr = process.hrtime.bigint();
                            const span = tracer.startSpan(`sqlite.${method}`, {
                                kind: SpanKind.CLIENT,
                                attributes: {
                                    'db.system': 'sqlite',
                                    'db.operation': method,
                                    'db.statement': options?.captureQueries !== false ? sanitizeQueryStatement(source, 2048) : undefined,
                                },
                            });
                            try {
                                const res = origMethod.apply(this, execArgs);
                                const endHr = process.hrtime.bigint();
                                const durationMs = Number(endHr - startHr) / 1e6;
                                span.setAttribute('db.sqlite.duration_ms', Math.round(durationMs * 100) / 100);
                                span.setStatus({ code: SpanStatusCode.OK });
                                span.end();
                                return res;
                            }
                            catch (err) {
                                span.recordException(err instanceof Error ? err : new Error(String(err)));
                                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) });
                                span.end();
                                throw err;
                            }
                        };
                    }
                    return statement;
                };
                unpatches.push(() => {
                    DatabaseClass.prototype.prepare = origPrepare;
                });
            }
        }
        return () => {
            for (const fn of unpatches)
                fn();
        };
    });
    return {
        enable: () => { active = true; },
        disable: () => { active = false; },
        teardown: () => {
            active = false;
        },
    };
}
