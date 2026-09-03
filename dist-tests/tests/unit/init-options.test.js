import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sdkInitOptionsSchema } from '../../src/types/config.js';
describe('SDK initialization option boundary', () => {
    it('accepts local integration concerns', () => {
        const result = sdkInitOptionsSchema.safeParse({
            apiKey: 'test-key',
            applicationName: 'orders',
            applicationVersion: '1.2.3',
            maxBreadcrumbs: 100,
            debug: true,
            shutdownTimeoutMs: 5_000,
            sourceMaps: { paths: ['./dist'], allowRemote: false },
        });
        assert.equal(result.success, true);
    });
    it('rejects caller-provided baseUrl because the control-plane route is fixed', () => {
        const result = sdkInitOptionsSchema.safeParse({ apiKey: 'test-key', baseUrl: 'https://api.example.test' });
        assert.equal(result.success, false);
    });
    for (const [name, value] of Object.entries({
        service: 'orders',
        environment: 'production',
        release: '1.2.3',
        configUrl: 'https://api.example.test/v1/sdk-config',
        enableErrors: true,
        enableTracing: true,
        enableMetrics: true,
        sampleRate: 0.5,
        transport: { batchSize: 10 },
        dataScrubbing: { redactRequestBody: true },
        otelMetrics: { cardinalityLimit: 100 },
    })) {
        it(`rejects removed local policy field ${name}`, () => {
            const result = sdkInitOptionsSchema.safeParse({ apiKey: 'test-key', [name]: value });
            assert.equal(result.success, false);
        });
    }
});
