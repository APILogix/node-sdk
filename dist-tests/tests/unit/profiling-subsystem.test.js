import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProfilingSubsystem } from '../../src/subsystems/profiling-subsystem.js';
import { EntitlementGate } from '../../src/core/entitlement-gate.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
const TEST_METADATA = {
    sdkName: 'pulse-node',
    sdkVersion: '0.0.0-test',
    applicationName: 'profiling-test',
    applicationVersion: '1.0.0',
    projectId: 'test-project',
    environment: 'test',
    release: '1.0.0',
};
function profilingConfig() {
    return {
        ...TEST_REMOTE_CONFIG,
        features: { ...TEST_REMOTE_CONFIG.features, profiling: true },
        sampling: { ...TEST_REMOTE_CONFIG.sampling, profiles: 1 },
    };
}
function installSession(subsystem, session) {
    ;
    subsystem.inspectorSession = {
        ...session,
        disconnect: session.disconnect ?? (() => undefined),
    };
    subsystem.inspectorAvailable = true;
}
describe('ProfilingSubsystem', () => {
    afterEach(() => {
        ProfilingSubsystem.reset();
        EntitlementGate.reset();
    });
    it('allows only one active CPU profile per inspector session', async () => {
        EntitlementGate.initialize({ ...TEST_REMOTE_CONFIG.entitlements, profiling: true });
        const emitted = [];
        const subsystem = ProfilingSubsystem.initialize(profilingConfig(), event => emitted.push(event), TEST_METADATA);
        const posts = [];
        installSession(subsystem, {
            async post(method) {
                posts.push(method);
                if (method === 'Profiler.stop')
                    return { profile: { nodes: [] } };
                return {};
            },
        });
        assert.equal(await subsystem.startCpuProfile('trace-a', 'span-a'), true);
        assert.equal(await subsystem.startCpuProfile('trace-b', 'span-b'), false);
        assert.deepEqual(posts, ['Profiler.enable', 'Profiler.start']);
        await subsystem.stopCpuProfile('trace-a');
        assert.equal(emitted.length, 1);
        assert.deepEqual(posts, ['Profiler.enable', 'Profiler.start', 'Profiler.stop']);
    });
    it('does not warn when V8 reports that a CPU profile was already stopped', async () => {
        EntitlementGate.initialize({ ...TEST_REMOTE_CONFIG.entitlements, profiling: true });
        const subsystem = ProfilingSubsystem.initialize(profilingConfig(), () => undefined, TEST_METADATA);
        let shouldFailStop = false;
        installSession(subsystem, {
            async post(method) {
                if (method === 'Profiler.stop' && shouldFailStop) {
                    throw new Error('Inspector error -32000: No recording profiles found');
                }
                return method === 'Profiler.stop' ? { profile: { nodes: [] } } : {};
            },
        });
        assert.equal(await subsystem.startCpuProfile('trace-a', 'span-a'), true);
        shouldFailStop = true;
        const originalWrite = process.stderr.write;
        let stderr = '';
        process.stderr.write = ((chunk) => {
            stderr += chunk.toString();
            return true;
        });
        try {
            await subsystem.stopCpuProfile('trace-a');
        }
        finally {
            process.stderr.write = originalWrite;
        }
        assert.equal(stderr.includes('Failed to stop CPU profile'), false);
    });
});
