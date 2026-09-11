import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSDK, shutdown } from '../../src/index.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
const originalFetch = globalThis.fetch;
const instrumentationGuard = Symbol.for('pulse-sdk.auto-instrumentation.registered');
const bootstrapGuard = Symbol.for('pulse-sdk.auto-instrumentation.bootstrap');
describe('auto-instrumentation bootstrap', () => {
    afterEach(async () => {
        globalThis.fetch = originalFetch;
        await shutdown(2_000);
    });
    it('registers module-load hooks on normal SDK import and rebuilds them from remote config during init', async () => {
        const globalState = globalThis;
        assert.equal(globalState[instrumentationGuard], true, 'SDK import should install auto-instrumentation hooks immediately');
        assert.equal(globalState[bootstrapGuard], true, 'pre-init hooks should be marked as bootstrap hooks');
        globalThis.fetch = (async (url) => {
            if (String(url).includes('/v1/init')) {
                return new Response(JSON.stringify({
                    success: true,
                    projectId: 'bootstrap-project',
                    environment: 'test',
                    release: '1.0.0',
                    config: {
                        ...TEST_REMOTE_CONFIG,
                        sdk: {
                            ...TEST_REMOTE_CONFIG.sdk,
                            projectId: 'bootstrap-project',
                            environment: 'test',
                            release: '1.0.0',
                        },
                        features: {
                            ...TEST_REMOTE_CONFIG.features,
                            tracing: true,
                            requestCapture: true,
                        },
                        sampling: {
                            ...TEST_REMOTE_CONFIG.sampling,
                            traces: 1,
                            spans: 1,
                            requests: 1,
                        },
                    },
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const config = await createSDK({ apiKey: 'test-bootstrap-key' });
        assert.equal(config?.sdk.projectId, 'bootstrap-project');
        assert.equal(globalState[instrumentationGuard], true, 'remote-config registration should remain active after init');
        assert.equal(globalState[bootstrapGuard], undefined, 'bootstrap marker should be cleared after remote-config rebuild');
    });
});
