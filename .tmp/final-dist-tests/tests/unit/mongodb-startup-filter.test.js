import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMongoDBInstrumentation } from '../../src/instrumentation/mongodb.js';
import { context, trace, SpanKind } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
describe('MongoDB Startup Index Command Filtering', () => {
    let memoryExporter;
    let provider;
    beforeEach(() => {
        memoryExporter = new InMemorySpanExporter();
        provider = new NodeTracerProvider({
            spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
        });
        provider.register();
    });
    it('1. Filters out standalone createIndexes command when no parent span is active', () => {
        const inst = createMongoDBInstrumentation(true);
        inst?.setTracerProvider(provider);
        assert.ok(inst, 'Instrumentation instance created');
        let originalCalled = false;
        const mockOriginal = function (ns, cmd, options, callback) {
            originalCalled = true;
            if (typeof callback === 'function')
                callback(null, { ok: 1 });
            return { ok: 1 };
        };
        const patcher = inst._getV4PatchCommandCallback();
        const patchedFn = patcher(mockOriginal);
        // Execute createIndexes without active span
        const cmd = { createIndexes: 'users', indexes: [{ key: { email: 1 } }] };
        patchedFn.call({}, { db: 'test', collection: 'users' }, cmd, {}, () => { });
        assert.equal(originalCalled, true, 'Original command must execute');
        assert.equal(memoryExporter.getFinishedSpans().length, 0, 'No span should be created for standalone createIndexes');
    });
    it('2. Preserves find query instrumentation even without parent span', () => {
        const inst = createMongoDBInstrumentation(true);
        inst?.setTracerProvider(provider);
        assert.ok(inst);
        let originalCalled = false;
        const mockOriginal = function (ns, cmd, options, callback) {
            originalCalled = true;
            if (typeof callback === 'function')
                callback(null, { ok: 1 });
            return { ok: 1 };
        };
        const patcher = inst._getV4PatchCommandCallback();
        const patchedFn = patcher(mockOriginal);
        // Execute regular find query without active span
        const cmd = { find: 'users', filter: { active: true } };
        patchedFn.call({ id: 'conn-1' }, { db: 'test', collection: 'users' }, cmd, {}, () => { });
        assert.equal(originalCalled, true, 'Original command must execute');
        assert.equal(memoryExporter.getFinishedSpans().length, 1, 'Regular find command should still be traced');
    });
});
