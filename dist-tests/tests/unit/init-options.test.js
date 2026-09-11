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
            initTimeoutMs: 500,
            sourceMaps: { paths: ['./dist'], allowRemote: false },
        });
        assert.equal(result.success, true);
    });
    it('rejects invalid startup deadlines', () => {
        for (const initTimeoutMs of [0, -1, 99, 30_001, Infinity, NaN, 100.5]) {
            assert.equal(sdkInitOptionsSchema.safeParse({ apiKey: 'test-key', initTimeoutMs }).success, false);
        }
    });
    for (const [name, value] of Object.entries({
        baseUrl: 'https://api.example.test',
        timeoutMs: 5_000,
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
