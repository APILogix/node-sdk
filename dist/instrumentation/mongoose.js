/**
 * Mongoose ODM Instrumentation — captures high-level ODM operations
 * (e.g. User.findOne, user.save, OrgMember.find, Session.create)
 * and nests them cleanly within active HTTP request spans.
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { getLogger } from '../utils/logger.js';
const MODULE_NAME = 'mongoose';
const INSTRUMENTATION_NAME = '@pulse-apm/instrumentation-mongoose';
const INSTRUMENTATION_VERSION = '1.0.0';
export class MongooseInstrumentation extends InstrumentationBase {
    _captureConfig;
    _isPatched = false;
    _patchedMongooseRef = null;
    _originalExec = null;
    _originalSave = null;
    _originalAggregateExec = null;
    constructor(config = { enabled: true }, captureConfig) {
        super(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION, config);
        this._captureConfig = captureConfig;
        this._checkExistingModule();
    }
    init() {
        return [
            new InstrumentationNodeModuleDefinition(MODULE_NAME, ['>=5.0.0 <9'], (moduleExports) => {
                this._patchMongoose(moduleExports);
                return moduleExports;
            }, (moduleExports) => {
                this._unpatchMongoose(moduleExports);
            }),
        ];
    }
    enable() {
        super.enable();
        this._checkExistingModule();
    }
    disable() {
        super.disable();
        if (this._patchedMongooseRef) {
            this._unpatchMongoose(this._patchedMongooseRef);
        }
    }
    updateCaptureConfig(captureConfig) {
        this._captureConfig = captureConfig;
    }
    _checkExistingModule() {
        if (this._isPatched)
            return;
        // 1. Check globalThis.mongoose (e.g. global.mongoose cache in apps)
        const g = globalThis;
        if (g.mongoose && g.mongoose.Query) {
            this._patchMongoose(g.mongoose);
            return;
        }
        // 2. Check require.cache if available in CJS/mixed contexts
        try {
            const nodeRequire = globalThis.require || (typeof require !== 'undefined' ? require : null);
            if (nodeRequire?.cache) {
                for (const key of Object.keys(nodeRequire.cache)) {
                    if (key.includes('mongoose') && nodeRequire.cache[key]?.exports?.Query) {
                        this._patchMongoose(nodeRequire.cache[key].exports);
                        break;
                    }
                }
            }
        }
        catch { }
    }
    _patchMongoose(mongoose) {
        if (!mongoose || this._isPatched)
            return;
        const Query = mongoose.Query;
        const Model = mongoose.Model;
        const Aggregate = mongoose.Aggregate;
        if (!Query?.prototype || !Model?.prototype)
            return;
        this._patchedMongooseRef = mongoose;
        this._isPatched = true;
        const self = this;
        const logger = getLogger();
        // ─── 1. Patch Query.prototype.exec ──────────────────────────────────
        if (!this._originalExec && typeof Query.prototype.exec === 'function') {
            this._originalExec = Query.prototype.exec;
            const origExec = this._originalExec;
            Query.prototype.exec = function pulsePatchedQueryExec(op, callback) {
                if (!self.isEnabled()) {
                    return origExec.apply(this, arguments);
                }
                if (typeof op === 'function') {
                    callback = op;
                    op = null;
                }
                else if (typeof op === 'string') {
                    this.op = op;
                }
                const operation = this.op || 'query';
                const modelName = this.model?.modelName || this.model?.collection?.name || 'Collection';
                const collectionName = this.model?.collection?.name || this.model?.modelName || 'collection';
                const dbName = this.model?.db?.name || 'db';
                const spanName = `${modelName}.${operation}`;
                const captureBody = self._captureConfig?.body ?? false;
                let statement = '[REDACTED]';
                if (captureBody) {
                    try {
                        const filter = typeof this.getFilter === 'function' ? this.getFilter() : this._conditions;
                        statement = JSON.stringify(filter);
                    }
                    catch {
                        statement = '[UNSERIALIZABLE]';
                    }
                }
                const tracer = self.tracer;
                return tracer.startActiveSpan(spanName, {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        'db.system': 'mongodb',
                        'db.name': dbName,
                        'db.mongodb.collection': collectionName,
                        'db.operation': operation,
                        'db.statement': statement,
                    },
                }, (span) => {
                    let promise;
                    try {
                        promise = origExec.apply(this, arguments);
                    }
                    catch (err) {
                        span.recordException(err);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                        span.end();
                        throw err;
                    }
                    if (promise && typeof promise.then === 'function') {
                        return promise.then((res) => {
                            span.end();
                            return res;
                        }, (err) => {
                            span.recordException(err);
                            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                            span.end();
                            throw err;
                        });
                    }
                    span.end();
                    return promise;
                });
            };
        }
        // ─── 2. Patch Model.prototype.save ──────────────────────────────────
        if (!this._originalSave && typeof Model.prototype.save === 'function') {
            this._originalSave = Model.prototype.save;
            const origSave = this._originalSave;
            Model.prototype.save = function pulsePatchedModelSave(...args) {
                if (!self.isEnabled()) {
                    return origSave.apply(this, args);
                }
                const modelName = this.constructor?.modelName || 'Document';
                const collectionName = this.collection?.name || modelName;
                const dbName = this.db?.name || 'db';
                const isNew = Boolean(this.isNew);
                const operation = isNew ? 'insert' : 'save';
                const spanName = `${modelName}.save`;
                const tracer = self.tracer;
                return tracer.startActiveSpan(spanName, {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        'db.system': 'mongodb',
                        'db.name': dbName,
                        'db.mongodb.collection': collectionName,
                        'db.operation': operation,
                    },
                }, (span) => {
                    let res;
                    try {
                        res = origSave.apply(this, args);
                    }
                    catch (err) {
                        span.recordException(err);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                        span.end();
                        throw err;
                    }
                    if (res && typeof res.then === 'function') {
                        return res.then((doc) => {
                            span.end();
                            return doc;
                        }, (err) => {
                            span.recordException(err);
                            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                            span.end();
                            throw err;
                        });
                    }
                    span.end();
                    return res;
                });
            };
        }
        // ─── 3. Patch Aggregate.prototype.exec ──────────────────────────────
        if (Aggregate?.prototype && !this._originalAggregateExec && typeof Aggregate.prototype.exec === 'function') {
            this._originalAggregateExec = Aggregate.prototype.exec;
            const origAggregateExec = this._originalAggregateExec;
            Aggregate.prototype.exec = function pulsePatchedAggregateExec(...args) {
                if (!self.isEnabled()) {
                    return origAggregateExec.apply(this, args);
                }
                const modelName = this.model?.()?.modelName || 'Aggregate';
                const spanName = `${modelName}.aggregate`;
                const dbName = this.model?.()?.db?.name || 'db';
                const collectionName = this.model?.()?.collection?.name || modelName;
                const tracer = self.tracer;
                return tracer.startActiveSpan(spanName, {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        'db.system': 'mongodb',
                        'db.name': dbName,
                        'db.mongodb.collection': collectionName,
                        'db.operation': 'aggregate',
                    },
                }, (span) => {
                    let promise;
                    try {
                        promise = origAggregateExec.apply(this, args);
                    }
                    catch (err) {
                        span.recordException(err);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                        span.end();
                        throw err;
                    }
                    if (promise && typeof promise.then === 'function') {
                        return promise.then((res) => {
                            span.end();
                            return res;
                        }, (err) => {
                            span.recordException(err);
                            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                            span.end();
                            throw err;
                        });
                    }
                    span.end();
                    return promise;
                });
            };
        }
        logger.debug('Mongoose ODM auto-instrumentation successfully attached');
    }
    _unpatchMongoose(mongoose) {
        if (!mongoose || !this._isPatched)
            return;
        if (this._originalExec && mongoose.Query?.prototype) {
            mongoose.Query.prototype.exec = this._originalExec;
            this._originalExec = null;
        }
        if (this._originalSave && mongoose.Model?.prototype) {
            mongoose.Model.prototype.save = this._originalSave;
            this._originalSave = null;
        }
        if (this._originalAggregateExec && mongoose.Aggregate?.prototype) {
            mongoose.Aggregate.prototype.exec = this._originalAggregateExec;
            this._originalAggregateExec = null;
        }
        this._isPatched = false;
        this._patchedMongooseRef = null;
    }
}
export function createMongooseInstrumentation(enabled, captureConfig) {
    if (!enabled)
        return null;
    return new MongooseInstrumentation({ enabled: true }, captureConfig);
}
export default createMongooseInstrumentation;
