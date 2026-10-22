/**
 * MikroORM Instrumentation — auto-instrumentation for MikroORM EntityManager.
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js';
const MIKROORM_GUARD = Symbol.for('pulse-sdk.patch.mikroorm');
export function createMikroORMInstrumentation(enabled) {
    if (!enabled)
        return null;
    const mikro = resolveModuleSafe('@mikro-orm/core');
    if (!mikro)
        return null;
    const EntityManager = mikro.EntityManager ?? mikro.default?.EntityManager;
    if (!EntityManager || !EntityManager.prototype)
        return null;
    let active = true;
    applyIdempotentPatch(MIKROORM_GUARD, () => {
        const origFlush = EntityManager.prototype.flush;
        if (typeof origFlush === 'function') {
            EntityManager.prototype.flush = function pulseMikroOrmFlush(...args) {
                if (!active)
                    return origFlush.apply(this, args);
                const tracer = trace.getTracer('@lynktrace/node-mikroorm');
                const span = tracer.startSpan('mikroorm.flush', {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        'db.orm': 'mikro-orm',
                        'db.operation': 'flush',
                    },
                });
                const promise = origFlush.apply(this, args);
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
        }
        return () => {
            if (typeof origFlush === 'function')
                EntityManager.prototype.flush = origFlush;
        };
    });
    return {
        enable: () => { active = true; },
        disable: () => { active = false; },
        teardown: () => { active = false; },
    };
}
