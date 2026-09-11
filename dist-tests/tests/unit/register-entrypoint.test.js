import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const instrumentationGuard = Symbol.for('pulse-sdk.auto-instrumentation.registered');
const bootstrapGuard = Symbol.for('pulse-sdk.auto-instrumentation.bootstrap');
describe('process register bootstrap entrypoint', () => {
    afterEach(async () => {
        const { shutdown } = await import('../../src/index.js');
        await shutdown(2_000);
    });
    it('shares bootstrap state with the normal SDK import without double registration', async () => {
        const globalState = globalThis;
        await import('../../src/register.js');
        const teardownsBeforeRootImport = globalState[Symbol.for('pulse-sdk.auto-instrumentation.teardowns')];
        assert.equal(globalState[instrumentationGuard], true, 'register entrypoint should install auto-instrumentation hooks');
        assert.equal(globalState[bootstrapGuard], true, 'register entrypoint should mark hooks as bootstrap hooks');
        await import('../../src/index.js');
        assert.equal(globalState[instrumentationGuard], true, 'normal import should preserve the shared instrumentation guard');
        assert.equal(globalState[bootstrapGuard], true, 'normal import should not convert bootstrap hooks into runtime hooks');
        assert.equal(globalState[Symbol.for('pulse-sdk.auto-instrumentation.teardowns')], teardownsBeforeRootImport, 'normal import should not rebuild bootstrap instrumentation after register preload');
    });
});
