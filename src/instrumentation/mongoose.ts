/**
 * Mongoose ODM Instrumentation — captures high-level ODM operations
 * (e.g. User.findOne, user.save, OrgMember.find, Session.create)
 * and nests them cleanly within active HTTP request spans.
 */

import * as nodeModule from 'node:module'
import { context, createContextKey, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation'
import type { PrivacyCaptureConfig } from '../types/config.js'
import { getLogger } from '../utils/logger.js'
import { SUPPRESS_MONGODB_DRIVER_SPANS } from './mongodb.js'

export interface MongooseInstrumentationOptions {
  enabled: boolean
  captureQueries?: boolean
  captureParams?: boolean
}

const MODULE_NAME = 'mongoose'
const INSTRUMENTATION_NAME = '@lynktrace/instrumentation-mongoose'
const INSTRUMENTATION_VERSION = '1.0.0'
const SUPPRESS_NESTED_MONGOOSE_SPANS = createContextKey('lynktrace.mongoose.suppress-nested-spans')
const SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY = createContextKey('pulse-sdk.mongoose.suppress-nested-spans')

type MongooseSpanAttributes = Record<string, string | number | boolean>

export class MongooseInstrumentation extends InstrumentationBase {
  private _captureConfig?: PrivacyCaptureConfig | undefined
  private _isPatched = false
  private _patchedMongooseRef: any = null
  private _originalExec: any = null
  private _originalSave: any = null
  private _originalAggregateExec: any = null
  private _originalCreate: any = null
  private _originalInsertMany: any = null
  private _originalBulkWrite: any = null
  private _originalPopulate: any = null

  constructor(
    config: MongooseInstrumentationOptions = { enabled: true },
    captureConfig?: PrivacyCaptureConfig
  ) {
    super(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION, config)
    this._captureConfig = captureConfig
    this._checkExistingModule()
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        MODULE_NAME,
        ['>=5.0.0 <9'],
        (moduleExports: any) => {
          const patched = this._patchMongoose(moduleExports)
          if (!patched) {
            getLogger().debug('Mongoose module detected but exports were not patchable', {
              hasDefault: Boolean(moduleExports?.default),
              hasQuery: Boolean(moduleExports?.Query),
              hasDefaultQuery: Boolean(moduleExports?.default?.Query),
            })
          }
          return moduleExports
        },
        (moduleExports: any) => {
          this._unpatchMongoose(moduleExports)
        }
      ),
    ]
  }

  public override enable(): void {
    super.enable()
    this._checkExistingModule()
  }

  public override disable(): void {
    super.disable()
    if (this._patchedMongooseRef) {
      this._unpatchMongoose(this._patchedMongooseRef)
    }
  }

  public updateCaptureConfig(captureConfig?: PrivacyCaptureConfig): void {
    this._captureConfig = captureConfig
  }

  public _checkExistingModule(): void {
    if (this._isPatched) return

    // 1. Check globalThis.mongoose (e.g. global.mongoose cache in apps)
    const g = globalThis as any
    if (g.mongoose) {
      if (this._patchMongoose(g.mongoose)) return
      if (g.mongoose.conn && this._patchMongoose(g.mongoose.conn.base || g.mongoose.conn)) return
      if (g.mongoose.connection && this._patchMongoose(g.mongoose.connection.base || g.mongoose.connection)) return
      if (g.mongoose.promise && typeof g.mongoose.promise.then === 'function') {
        g.mongoose.promise.then((m: any) => {
          if (!this._isPatched && m) {
            this._patchMongoose(m.base || m)
          }
        }).catch(() => {})
      }
    }

    // 2. Scan globalThis for common Mongoose instances
    for (const key of Object.keys(g)) {
      if (key.toLowerCase().includes('mongo') || key.toLowerCase().includes('db')) {
        const candidate = g[key]
        if (candidate && typeof candidate === 'object') {
          if (this._patchMongoose(candidate)) return
        }
      }
    }

    // 3. Check require.cache if available in CJS/mixed contexts
    try {
      const nodeRequire = (globalThis as any).require || (typeof require !== 'undefined' ? require : null)
      if (nodeRequire?.cache) {
        for (const key of Object.keys(nodeRequire.cache)) {
          if (key.includes('mongoose') && nodeRequire.cache[key]?.exports) {
            if (this._patchMongoose(nodeRequire.cache[key].exports)) break
          }
        }
      }
    } catch {}

    // 4. In native ESM, use createRequire if available to resolve mongoose from host application
    if (!this._isPatched) {
      try {
        const createReq = (nodeModule as any).createRequire
        if (typeof createReq === 'function') {
          const hostRequire = createReq(process.cwd() + '/package.json')
          const resolved = hostRequire.resolve('mongoose')
          if (resolved && hostRequire.cache && hostRequire.cache[resolved]) {
            this._patchMongoose(hostRequire.cache[resolved].exports)
          }
        }
      } catch {}
    }
  }

  private _resolveMongooseExports(moduleExports: any): any | null {
    if (!moduleExports) return null

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
    ]

    for (const candidate of candidates) {
      if (candidate?.Query?.prototype && candidate?.Model?.prototype) {
        return candidate
      }
    }

    return null
  }

  private _baseAttributes(dbName: string, collectionName: string, operation: string, conn?: any): MongooseSpanAttributes {
    const readyState = conn?.readyState ?? (this._patchedMongooseRef?.connection?.readyState)
    const isBuffering = readyState !== undefined && readyState !== 1
    const connectionState = readyState === 1 ? 'connected' : readyState === 0 ? 'disconnected' : readyState === 2 ? 'connecting' : readyState === 3 ? 'disconnecting' : undefined

    return {
      'db.system': 'mongodb',
      'db.system.name': 'mongodb',
      'db.name': dbName,
      'db.namespace': dbName,
      'db.mongodb.collection': collectionName,
      'db.collection.name': collectionName,
      'db.operation': operation,
      'db.operation.name': operation,
      'lynktrace.instrumentation.layer': 'mongoose',
      'pulse.instrumentation.layer': 'mongoose',
      ...(readyState !== undefined ? {
        'db.mongodb.buffering': isBuffering,
        ...(connectionState ? { 'db.mongodb.connection_state': connectionState } : {}),
      } : {}),
    }
  }

  private _endSpan(span: any, err?: any): void {
    if (err) {
      span.recordException(err)
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) })
    }
    span.end()
  }

  private _wrapLastCallback(args: any[], endWithError: (err: any) => void, endOk: () => void): { args: any[], wrapped: boolean } {
    const last = args.length > 0 ? args[args.length - 1] : undefined
    if (typeof last !== 'function') {
      return { args, wrapped: false }
    }

    const wrappedArgs = args.slice()
    wrappedArgs[wrappedArgs.length - 1] = function lynktraceMongooseCallback(this: any, err: any, ...rest: any[]) {
      if (err) endWithError(err)
      else endOk()
      return last.apply(this, [err, ...rest])
    }
    return { args: wrappedArgs, wrapped: true }
  }

  private _withMongooseSpan<T>(
    spanName: string,
    attributes: MongooseSpanAttributes,
    invoke: (endWithError: (err: any) => void, endOk: () => void) => { result: T, callbackWrapped?: boolean },
    suppressNested = false
  ): T {
    const tracer = this.tracer
    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes,
      },
      (span) => {
        let ended = false
        const endOk = () => {
          if (ended) return
          ended = true
          this._endSpan(span)
        }
        const endWithError = (err: any) => {
          if (ended) return
          ended = true
          this._endSpan(span, err)
        }

        const run = () => invoke(endWithError, endOk)

        try {
          let invocationContext = context.active().setValue(SUPPRESS_MONGODB_DRIVER_SPANS, true)
          if (suppressNested) {
            invocationContext = invocationContext
              .setValue(SUPPRESS_NESTED_MONGOOSE_SPANS, true)
              .setValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY, true)
          }
          const { result, callbackWrapped } = context.with(invocationContext, run)

          if (!callbackWrapped && result && typeof (result as any).then === 'function') {
            return (result as any).then(
              (value: any) => {
                endOk()
                return value
              },
              (err: any) => {
                endWithError(err)
                throw err
              }
            )
          }

          if (!callbackWrapped) {
            endOk()
          }
          return result
        } catch (err: any) {
          endWithError(err)
          throw err
        }
      }
    ) as T
  }

  private _patchMongoose(moduleExports: any): boolean {
    const mongoose = this._resolveMongooseExports(moduleExports)
    if (!mongoose || this._isPatched) return false
    const Query = mongoose.Query
    const Model = mongoose.Model
    const Aggregate = mongoose.Aggregate

    if (!Query?.prototype || !Model?.prototype) return false

    this._patchedMongooseRef = mongoose
    this._isPatched = true
    const self = this
    const logger = getLogger()

    // ─── 1. Patch Query.prototype.exec ──────────────────────────────────
    if (!this._originalExec && typeof Query.prototype.exec === 'function') {
      this._originalExec = Query.prototype.exec
      const origExec = this._originalExec

      Query.prototype.exec = function pulsePatchedQueryExec(this: any, op?: any, callback?: any) {
        if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS) || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY)) {
          return origExec.apply(this, arguments as any)
        }

        if (typeof op === 'function') {
          callback = op
          op = null
        } else if (typeof op === 'string') {
          this.op = op
        }

        const operation = this.op || 'query'
        const modelName = this.model?.modelName || this.model?.collection?.name || 'Collection'
        const collectionName = this.model?.collection?.name || this.model?.modelName || 'collection'
        const dbName = this.model?.db?.name || 'db'
        const spanName = `${modelName}.${operation}`

        const captureBody = self._captureConfig?.body ?? false
        let statement = '[REDACTED]'
        if (captureBody) {
          try {
            const filter = typeof this.getFilter === 'function' ? this.getFilter() : this._conditions
            statement = JSON.stringify(filter)
          } catch {
            statement = '[UNSERIALIZABLE]'
          }
        }

        const attributes = {
          ...self._baseAttributes(dbName, collectionName, operation, this.model?.db || this.db),
          'db.statement': statement,
        }
        const originalArgs = Array.from(arguments as any)
        return self._withMongooseSpan(
          spanName,
          attributes,
          (endWithError, endOk) => {
            const wrapped = self._wrapLastCallback(originalArgs, endWithError, endOk)
            return { result: origExec.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped }
          }
        )
      }
    }

    // ─── 2. Patch Model.prototype.save ──────────────────────────────────
    if (!this._originalSave && typeof Model.prototype.save === 'function') {
      this._originalSave = Model.prototype.save
      const origSave = this._originalSave

      Model.prototype.save = function pulsePatchedModelSave(this: any, ...args: any[]) {
        if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS) || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY)) {
          return origSave.apply(this, args)
        }

        const modelName = this.constructor?.modelName || 'Document'
        const collectionName = this.collection?.name || modelName
        const dbName = this.db?.name || 'db'
        const isNew = Boolean(this.isNew)
        const operation = isNew ? 'insert' : 'save'
        const spanName = `${modelName}.save`

        return self._withMongooseSpan(
          spanName,
          self._baseAttributes(dbName, collectionName, operation, this.db),
          (endWithError, endOk) => {
            const wrapped = self._wrapLastCallback(args, endWithError, endOk)
            return { result: origSave.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped }
          }
        )
      }
    }

    // ─── 3. Patch static Model.create for direct create() calls ──────────
    if (!this._originalCreate && typeof Model.create === 'function') {
      this._originalCreate = Model.create
      const origCreate = this._originalCreate

      Model.create = function pulsePatchedModelCreate(this: any, ...args: any[]) {
        if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS) || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY)) {
          return origCreate.apply(this, args)
        }

        const modelName = this.modelName || this.collection?.name || 'Model'
        const collectionName = this.collection?.name || modelName
        const dbName = this.db?.name || 'db'
        return self._withMongooseSpan(
          `${modelName}.create`,
          self._baseAttributes(dbName, collectionName, 'create', this.db),
          (endWithError, endOk) => {
            const wrapped = self._wrapLastCallback(args, endWithError, endOk)
            return { result: origCreate.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped }
          },
          true
        )
      }
    }

    // ─── 4. Patch static Model.insertMany for bulk inserts ───────────────
    if (!this._originalInsertMany && typeof Model.insertMany === 'function') {
      this._originalInsertMany = Model.insertMany
      const origInsertMany = this._originalInsertMany

      Model.insertMany = function pulsePatchedModelInsertMany(this: any, ...args: any[]) {
        if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS) || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY)) {
          return origInsertMany.apply(this, args)
        }

        const modelName = this.modelName || this.collection?.name || 'Model'
        const collectionName = this.collection?.name || modelName
        const dbName = this.db?.name || 'db'
        return self._withMongooseSpan(
          `${modelName}.insertMany`,
          self._baseAttributes(dbName, collectionName, 'insertMany', this.db),
          (endWithError, endOk) => {
            const wrapped = self._wrapLastCallback(args, endWithError, endOk)
            return { result: origInsertMany.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped }
          },
          true
        )
      }
    }

    // ─── 5. Patch static Model.bulkWrite for raw model bulk operations ───
    if (!this._originalBulkWrite && typeof Model.bulkWrite === 'function') {
      this._originalBulkWrite = Model.bulkWrite
      const origBulkWrite = this._originalBulkWrite

      Model.bulkWrite = function pulsePatchedModelBulkWrite(this: any, ...args: any[]) {
        if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS) || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY)) {
          return origBulkWrite.apply(this, args)
        }

        const modelName = this.modelName || this.collection?.name || 'Model'
        const collectionName = this.collection?.name || modelName
        const dbName = this.db?.name || 'db'
        return self._withMongooseSpan(
          `${modelName}.bulkWrite`,
          self._baseAttributes(dbName, collectionName, 'bulkWrite', this.db),
          (endWithError, endOk) => {
            const wrapped = self._wrapLastCallback(args, endWithError, endOk)
            return { result: origBulkWrite.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped }
          },
          true
        )
      }
    }

    // ─── 6. Patch Aggregate.prototype.exec ──────────────────────────────
    if (Aggregate?.prototype && !this._originalAggregateExec && typeof Aggregate.prototype.exec === 'function') {
      this._originalAggregateExec = Aggregate.prototype.exec
      const origAggregateExec = this._originalAggregateExec

      Aggregate.prototype.exec = function pulsePatchedAggregateExec(this: any, ...args: any[]) {
        if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS) || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY)) {
          return origAggregateExec.apply(this, args)
        }

        const aggModel = typeof this.model === 'function' ? this.model() : (this.model ?? this._model)
        const modelName = aggModel?.modelName || 'Aggregate'
        const spanName = `${modelName}.aggregate`
        const dbName = aggModel?.db?.name || 'db'
        const collectionName = aggModel?.collection?.name || modelName

        return self._withMongooseSpan(
          spanName,
          self._baseAttributes(dbName, collectionName, 'aggregate'),
          (endWithError, endOk) => {
            const wrapped = self._wrapLastCallback(args, endWithError, endOk)
            return { result: origAggregateExec.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped }
          }
        )
      }
    }

    // ─── 7. Patch static Model.populate for explicit Model.populate calls ─
    if (!this._originalPopulate && typeof Model.populate === 'function') {
      this._originalPopulate = Model.populate
      const origPopulate = this._originalPopulate

      Model.populate = function pulsePatchedModelPopulate(this: any, ...args: any[]) {
        if (!self.isEnabled() || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS) || context.active().getValue(SUPPRESS_NESTED_MONGOOSE_SPANS_LEGACY)) {
          return origPopulate.apply(this, args)
        }

        const modelName = this.modelName || 'Model'
        const collectionName = this.collection?.name || modelName
        const dbName = this.db?.name || 'db'
        return self._withMongooseSpan(
          `${modelName}.populate`,
          self._baseAttributes(dbName, collectionName, 'populate', this.db),
          (endWithError, endOk) => {
            const wrapped = self._wrapLastCallback(args, endWithError, endOk)
            return { result: origPopulate.apply(this, wrapped.args), callbackWrapped: wrapped.wrapped }
          },
          true
        )
      }
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
    })
    return true
  }

  private _unpatchMongoose(moduleExports: any): void {
    const mongoose = this._resolveMongooseExports(moduleExports) || this._patchedMongooseRef
    if (!mongoose || !this._isPatched) return

    if (this._originalExec && mongoose.Query?.prototype) {
      mongoose.Query.prototype.exec = this._originalExec
      this._originalExec = null
    }

    if (this._originalSave && mongoose.Model?.prototype) {
      mongoose.Model.prototype.save = this._originalSave
      this._originalSave = null
    }

    if (this._originalCreate && mongoose.Model) {
      mongoose.Model.create = this._originalCreate
      this._originalCreate = null
    }

    if (this._originalInsertMany && mongoose.Model) {
      mongoose.Model.insertMany = this._originalInsertMany
      this._originalInsertMany = null
    }

    if (this._originalBulkWrite && mongoose.Model) {
      mongoose.Model.bulkWrite = this._originalBulkWrite
      this._originalBulkWrite = null
    }

    if (this._originalAggregateExec && mongoose.Aggregate?.prototype) {
      mongoose.Aggregate.prototype.exec = this._originalAggregateExec
      this._originalAggregateExec = null
    }

    if (this._originalPopulate && mongoose.Model) {
      mongoose.Model.populate = this._originalPopulate
      this._originalPopulate = null
    }

    this._isPatched = false
    this._patchedMongooseRef = null
  }
}

export function createMongooseInstrumentation(
  enabled: boolean,
  captureConfig?: PrivacyCaptureConfig
): MongooseInstrumentation | null {
  if (!enabled) return null
  return new MongooseInstrumentation({ enabled: true }, captureConfig)
}

export { MongooseInstrumentation as LynkTraceMongooseInstrumentation }

export default createMongooseInstrumentation
