/**
 * Mongoose ODM Instrumentation — captures high-level ODM operations
 * (e.g. User.findOne, user.save, OrgMember.find, Session.create)
 * and nests them cleanly within active HTTP request spans.
 */
import * as nodeModule from 'node:module';
import { context, createContextKey, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import { getLogger } from '../utils/logger.js';
import { SUPPRESS_MONGODB_DRIVER_SPANS } from './mongodb.js';
const MODULE_NAME = 'mongoose';
const INSTRUMENTATION_NAME = '@pulse-apm/instrumentation-mongoose';
const INSTRUMENTATION_VERSION = '1.0.0';
const SUPPRESS_NESTED_MONGOOSE_SPANS = createContextKey('pulse-sdk.mongoose.suppress-nested-spans');
export class MongooseInstrumentation extends InstrumentationBase {
    _captureConfig;
    _isPatched = false;
    _patchedMongooseRef = null;
    _originalExec = null;
    _originalSave = null;
    _originalAggregateExec = null;
    _originalCreate = null;
    _originalInsertMany = null;
    _originalBulkWrite = null;
    _originalPopulate = null;
    constructor(config = { enabled: true }, captureConfig) {
        super(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION, config);
        this._captureConfig = captureConfig;
        this._checkExistingModule();
    }
    init() {
        return [
            new InstrumentationNodeModuleDefinition(MODULE_NAME, ['>=5.0.0 <9'], (moduleExports) => {
                const patched = this._patchMongoose(moduleExports);
                if (!patched) {
                    getLogger().debug('Mongoose module detected but exports were not patchable', {
                        hasDefault: Boolean(moduleExports?.default),
                        hasQuery: Boolean(moduleExports?.Query),
                        hasDefaultQuery: Boolean(moduleExports?.default?.Query),
                    });
                }
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
        if (g.mongoose) {
            if (this._patchMongoose(g.mongoose))
                return;
            if (g.mongoose.conn && this._patchMongoose(g.mongoose.conn.base || g.mongoose.conn))
                return;
            if (g.mongoose.connection && this._patchMongoose(g.mongoose.connection.base || g.mongoose.connection))
                return;
            if (g.mongoose.promise && typeof g.mongoose.promise.then === 'function') {
                g.mongoose.promise.then((m) => {
                    if (!this._isPatched && m) {
                        this._patchMongoose(m.base || m);
                    }
                }).catch(() => { });
            }
        }
        // 2. Scan globalThis for common Mongoose instances
        for (const key of Object.keys(g)) {
            if (key.toLowerCase().includes('mongo') || key.toLowerCase().includes('db')) {
                const candidate = g[key];
                if (candidate && typeof candidate === 'object') {
                    if (this._patchMongoose(candidate))
                        return;
                }
            }
        }
        // 3. Check require.cache if available in CJS/mixed contexts
        try {
            const nodeRequire = globalThis.require || (typeof require !== 'undefined' ? require : null);
            if (nodeRequire?.cache) {
                for (const key of Object.keys(nodeRequire.cache)) {
                    if (key.includes('mongoose') && nodeRequire.cache[key]?.exports) {
                        if (this._patchMongoose(nodeRequire.cache[key].exports))
                            break;
                    }
                }
            }
        }
        catch { }
        // 4. In native ESM, use createRequire if available to resolve mongoose from host application
        if (!this._isPatched) {
            try {
                const createReq = nodeModule.createRequire;
                if (typeof createReq === 'function') {
                    const hostRequire = createReq(process.cwd() + '/package.json');
                    const resolved = hostRequire.resolve('mongoose');
                    if (resolved && hostRequire.cache && hostRequire.cache[resolved]) {
                        this._patchMongoose(hostRequire.cache[resolved].exports);
                    }
                }
            }
            catch { }
        }
    }
    _resolveMongooseExports(moduleExports) {
        if (!moduleExports)
            return null;
        const candidates = [
            moduleExports,
            moduleExports?.default,
            moduleExports?.mongoose,
            moduleExports?.base,
            moduleExports?.conn?.base,
            moduleExports?.connection?.base,
            moduleExports?.default?.default,
            moduleExports?.default?.mongoose,
            moduleExports?.default?.base,
        ];
        for (const candidate of candidates) {
            if (candidate?.Query?.prototype && candidate?.Model?.prototype) {
                return candidate;
            }
        }
        return null;
    }
    _baseAttributes(dbName, collectionName, operation, conn) {
        const readyState = conn?.readyState ?? (this._patchedMongooseRef?.connection?.readyState);
        const isBuffering = readyState !== undefined && readyState !== 1;
        const connectionState = readyState === 1 ? 'connected' : readyState === 0 ? 'disconnected' : readyState === 2 ? 'connecting' : readyState === 3 ? 'disconnecting' : undefined;
        return {
            'db.system': 'mongodb',
            'db.system.name': 'mongodb',
            'db.name': dbName,
            'db.namespace': dbName,
            'db.mongodb.collection': collectionName,
            'db.collection.name': collectionName,
            'db.operation': operation,
            'db.operation.name': operation,
            'pulse.instrumentation.layer': 'mongoose',
            ...(readyState !== undefined ? {
                'db.mongodb.buffering': isBuffering,
                ...(connectionState ? { 'db.mongodb.connection_state': connectionState } : {}),
            } : {}),
        };
    }
    _endSpan(span, err) {
        if (err) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
        }
        span.end();
    }
    _wrapLastCallback(args, endWithError, endOk) {
        const last = args.length > 0 ? args[args.length - 1] : undefined;
        if (typeof last !== 'function') {
            return { args, wrapped: false };
        }
        const wrappedArgs = args.slice();
        wrappedArgs[wrappedArgs.length - 1] = function pulseMongooseCallback(err, ...rest) {
            if (err)
                endWithError(err);
            else
                endOk();
            return last.apply(this, [err, ...rest]);
        };
        return { args: wrappedArgs, wrapped: true };
    }
    _withMongooseSpan(spanName, attributes, invoke, suppressNested = false) {
        const tracer = this.tracer;
        return tracer.startActiveSpan(spanName, {
            kind: SpanKind.CLIENT,
            attributes,
        }, (span) => {
            let ended = false;
            const endOk = () => {
                if (ended)
                    return;
                ended = true;
                this._endSpan(span);
            };
            const endWithError = (err) => {
                if (ended)
                    return;
                ended = true;
                this._endSpan(span, err);
            };
            const run = () => invoke(endWithError, endOk);
            try {
                let invocationContext = context.active().setValue(SUPPRESS_MONGODB_DRIVER_SPANS, true);
                if (suppressNested) {
                    invocationContext = invocationContext.setValue(SUPPRESS_NESTED_MONGOOSE_SPANS, true);
                }
                const { result, callbackWrapped } = context.with(invocationContext, run);
                if (result && typeof result.then === 'function') {
                    return result.then((value) => {
                        endOk();
                        return value;
                    }, (err) => {
                        endWithError(err);
                        throw err;
                    });
                }
                if (!callbackWrapped) {
                    endOk();
                }
                return result;
            }
            catch (err) {
                endWithError(err);
                throw err;
            }
        });
    }
    _patchMongoose(moduleExports) {
        const mongoose = this._resolveMongooseExports(moduleExports);
        if (!mongoose || this._isPatched)
            return false;
        const Query = mongoose.Query;
        const Model = mongoose.Model;
        const Aggregate = mongoose.Aggregate;
        if (!Query?.prototype || !Model?.prototype)
            return false;
        this._patchedMongooseRef = mongoose;
        this._isPatched = true;
        const self = this;
        const logger = getLogger();
        // ─── 1. Patch Query.prototype.exec ──────────────────────────────────
        if (!this._originalExec && typeof Query.prototype.exec === 'function') {
            this._originalExec = Query.prototype.exec;
            const origExec = this._originalExec;
            Query.prototype.exec = function pulsePatchedQueryExec(op, callback) {
                if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS)) {
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
                const attributes = {
                    ...self._baseAttributes(dbName, collectionName, operation, this.model?.db || this.db),
                    'db.statement': statement,
                };
                const originalArgs = Array.from(arguments);
                return self._withMongooseSpan(spanName, attributes, (endWithError, endOk) => {
                    const wrapped = self._wrapLastCallback(originalArgs, endWithError, endOk);
                    return { result: origExec.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped };
                });
            };
        }
        // ─── 2. Patch Model.prototype.save ──────────────────────────────────
        if (!this._originalSave && typeof Model.prototype.save === 'function') {
            this._originalSave = Model.prototype.save;
            const origSave = this._originalSave;
            Model.prototype.save = function pulsePatchedModelSave(...args) {
                if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS)) {
                    return origSave.apply(this, args);
                }
                const modelName = this.constructor?.modelName || 'Document';
                const collectionName = this.collection?.name || modelName;
                const dbName = this.db?.name || 'db';
                const isNew = Boolean(this.isNew);
                const operation = isNew ? 'insert' : 'save';
                const spanName = `${modelName}.save`;
                return self._withMongooseSpan(spanName, self._baseAttributes(dbName, collectionName, operation, this.db), (endWithError, endOk) => {
                    const wrapped = self._wrapLastCallback(args, endWithError, endOk);
                    return { result: origSave.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped };
                });
            };
        }
        // ─── 3. Patch static Model.create for direct create() calls ──────────
        if (!this._originalCreate && typeof Model.create === 'function') {
            this._originalCreate = Model.create;
            const origCreate = this._originalCreate;
            Model.create = function pulsePatchedModelCreate(...args) {
                if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS)) {
                    return origCreate.apply(this, args);
                }
                const modelName = this.modelName || this.collection?.name || 'Model';
                const collectionName = this.collection?.name || modelName;
                const dbName = this.db?.name || 'db';
                return self._withMongooseSpan(`${modelName}.create`, self._baseAttributes(dbName, collectionName, 'create', this.db), (endWithError, endOk) => {
                    const wrapped = self._wrapLastCallback(args, endWithError, endOk);
                    return { result: origCreate.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped };
                }, true);
            };
        }
        // ─── 4. Patch static Model.insertMany for bulk inserts ───────────────
        if (!this._originalInsertMany && typeof Model.insertMany === 'function') {
            this._originalInsertMany = Model.insertMany;
            const origInsertMany = this._originalInsertMany;
            Model.insertMany = function pulsePatchedModelInsertMany(...args) {
                if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS)) {
                    return origInsertMany.apply(this, args);
                }
                const modelName = this.modelName || this.collection?.name || 'Model';
                const collectionName = this.collection?.name || modelName;
                const dbName = this.db?.name || 'db';
                return self._withMongooseSpan(`${modelName}.insertMany`, self._baseAttributes(dbName, collectionName, 'insertMany', this.db), (endWithError, endOk) => {
                    const wrapped = self._wrapLastCallback(args, endWithError, endOk);
                    return { result: origInsertMany.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped };
                }, true);
            };
        }
        // ─── 5. Patch static Model.bulkWrite for raw model bulk operations ───
        if (!this._originalBulkWrite && typeof Model.bulkWrite === 'function') {
            this._originalBulkWrite = Model.bulkWrite;
            const origBulkWrite = this._originalBulkWrite;
            Model.bulkWrite = function pulsePatchedModelBulkWrite(...args) {
                if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS)) {
                    return origBulkWrite.apply(this, args);
                }
                const modelName = this.modelName || this.collection?.name || 'Model';
                const collectionName = this.collection?.name || modelName;
                const dbName = this.db?.name || 'db';
                return self._withMongooseSpan(`${modelName}.bulkWrite`, self._baseAttributes(dbName, collectionName, 'bulkWrite', this.db), (endWithError, endOk) => {
                    const wrapped = self._wrapLastCallback(args, endWithError, endOk);
                    return { result: origBulkWrite.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped };
                }, true);
            };
        }
        // ─── 6. Patch Aggregate.prototype.exec ──────────────────────────────
        if (Aggregate?.prototype && !this._originalAggregateExec && typeof Aggregate.prototype.exec === 'function') {
            this._originalAggregateExec = Aggregate.prototype.exec;
            const origAggregateExec = this._originalAggregateExec;
            Aggregate.prototype.exec = function pulsePatchedAggregateExec(...args) {
                if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS)) {
                    return origAggregateExec.apply(this, args);
                }
                const modelName = this.model?.()?.modelName || 'Aggregate';
                const spanName = `${modelName}.aggregate`;
                const dbName = this.model?.()?.db?.name || 'db';
                const collectionName = this.model?.()?.collection?.name || modelName;
                return self._withMongooseSpan(spanName, self._baseAttributes(dbName, collectionName, 'aggregate'), (endWithError, endOk) => {
                    const wrapped = self._wrapLastCallback(args, endWithError, endOk);
                    return { result: origAggregateExec.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped };
                });
            };
        }
        // ─── 7. Patch static Model.populate for explicit Model.populate calls ─
        if (!this._originalPopulate && typeof Model.populate === 'function') {
            this._originalPopulate = Model.populate;
            const origPopulate = this._originalPopulate;
            Model.populate = function pulsePatchedModelPopulate(...args) {
                if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS)) {
                    return origPopulate.apply(this, args);
                }
                const modelName = this.modelName || 'Model';
                const collectionName = this.collection?.name || modelName;
                const dbName = this.db?.name || 'db';
                return self._withMongooseSpan(`${modelName}.populate`, self._baseAttributes(dbName, collectionName, 'populate', this.db), (endWithError, endOk) => {
                    const wrapped = self._wrapLastCallback(args, endWithError, endOk);
                    return { result: origPopulate.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped };
                }, true);
            };
        }
        logger.debug('Mongoose ODM auto-instrumentation successfully attached', {
            version: mongoose.version,
            queryExec: Boolean(this._originalExec),
            modelSave: Boolean(this._originalSave),
            modelCreate: Boolean(this._originalCreate),
            insertMany: Boolean(this._originalInsertMany),
            bulkWrite: Boolean(this._originalBulkWrite),
            aggregateExec: Boolean(this._originalAggregateExec),
            populate: Boolean(this._originalPopulate),
        });
        return true;
    }
    _unpatchMongoose(moduleExports) {
        const mongoose = this._resolveMongooseExports(moduleExports) || this._patchedMongooseRef;
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
        if (this._originalCreate && mongoose.Model) {
            mongoose.Model.create = this._originalCreate;
            this._originalCreate = null;
        }
        if (this._originalInsertMany && mongoose.Model) {
            mongoose.Model.insertMany = this._originalInsertMany;
            this._originalInsertMany = null;
        }
        if (this._originalBulkWrite && mongoose.Model) {
            mongoose.Model.bulkWrite = this._originalBulkWrite;
            this._originalBulkWrite = null;
        }
        if (this._originalAggregateExec && mongoose.Aggregate?.prototype) {
            mongoose.Aggregate.prototype.exec = this._originalAggregateExec;
            this._originalAggregateExec = null;
        }
        if (this._originalPopulate && mongoose.Model) {
            mongoose.Model.populate = this._originalPopulate;
            this._originalPopulate = null;
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
