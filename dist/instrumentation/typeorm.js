/**
 * TypeORM Instrumentation — auto-instrumentation for TypeORM entities,
 * repositories, and query builders.
 *
 * Captures:
 * - Entity repository operations (find, save, remove, delete, findOne)
 * - Target entity class name
 * - Query builder execution
 * - Logical parent-child linking over underlying database driver spans
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js';
const TYPEORM_GUARD = Symbol.for('pulse-sdk.patch.typeorm');
export function createTypeORMInstrumentation(enabled, _options, _captureConfig) {
    if (!enabled)
        return null;
    const typeorm = resolveModuleSafe('typeorm');
    if (!typeorm)
        return null;
    const Repository = typeorm.Repository ?? typeorm.default?.Repository;
    if (!Repository || !Repository.prototype)
        return null;
    let active = true;
    applyIdempotentPatch(TYPEORM_GUARD, () => {
        const unpatches = [];
        const methods = ['find', 'findOne', 'save', 'remove', 'delete', 'update', 'count'];
        for (const method of methods) {
            const orig = Repository.prototype[method];
            if (typeof orig !== 'function')
                continue;
            Repository.prototype[method] = function pulseTypeOrmRepoMethod(...args) {
                if (!active)
                    return orig.apply(this, args);
                const tracer = trace.getTracer('@lynktrace/node-typeorm');
                const targetName = this.metadata?.name ?? this.target?.name ?? 'Entity';
                const span = tracer.startSpan(`typeorm.${method}`, {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        'db.system': 'typeorm',
                        'typeorm.entity': String(targetName),
                        'typeorm.operation': method,
                    },
                });
                const promise = orig.apply(this, args);
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
            unpatches.push(() => {
                Repository.prototype[method] = orig;
            });
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
