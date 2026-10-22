/**
 * Mongoose ODM Instrumentation — captures high-level ODM operations
 * (e.g. User.findOne, user.save, OrgMember.find, Session.create)
 * and nests them cleanly within active HTTP request spans.
 */
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface MongooseInstrumentationOptions {
    enabled: boolean;
    captureQueries?: boolean;
    captureParams?: boolean;
}
export declare class MongooseInstrumentation extends InstrumentationBase {
    private _captureConfig?;
    private _isPatched;
    private _patchedMongooseRef;
    private _originalExec;
    private _originalSave;
    private _originalAggregateExec;
    private _originalCreate;
    private _originalInsertMany;
    private _originalBulkWrite;
    private _originalPopulate;
    constructor(config?: MongooseInstrumentationOptions, captureConfig?: PrivacyCaptureConfig);
    protected init(): InstrumentationNodeModuleDefinition[];
    enable(): void;
    disable(): void;
    updateCaptureConfig(captureConfig?: PrivacyCaptureConfig): void;
    _checkExistingModule(): void;
    private _resolveMongooseExports;
    private _baseAttributes;
    private _endSpan;
    private _wrapLastCallback;
    private _withMongooseSpan;
    private _patchMongoose;
    private _unpatchMongoose;
}
export declare function createMongooseInstrumentation(enabled: boolean, captureConfig?: PrivacyCaptureConfig): MongooseInstrumentation | null;
export { MongooseInstrumentation as LynkTraceMongooseInstrumentation };
export default createMongooseInstrumentation;
