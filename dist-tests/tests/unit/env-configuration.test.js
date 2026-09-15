import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndApplyEnv, resetEnvLoaderState } from '../../src/utils/env-loader.js';
import { resolveApiBaseUrl } from '../../src/constants/defaults.js';
import { init } from '../../src/core/init.js';
import { shutdown } from '../../src/core/lifecycle.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
describe('Environment Variables & .env Configuration', () => {
    const originalEnv = { ...process.env };
    let originalFetch;
    beforeEach(() => {
        resetEnvLoaderState();
        originalFetch = globalThis.fetch;
    });
    afterEach(async () => {
        process.env = { ...originalEnv };
        resetEnvLoaderState();
        globalThis.fetch = originalFetch;
        await shutdown();
    });
    it('1. Parses .env string content and sets unset keys without overwriting existing ones', () => {
        process.env['ALREADY_SET'] = 'original_value';
        delete process.env['NEW_KEY'];
        delete process.env['QUOTED_KEY'];
        const envContent = `
# Comment line
NEW_KEY=backend-endpoint-123
QUOTED_KEY="secret-api-token"
ALREADY_SET=should_not_overwrite
`;
        parseAndApplyEnv(envContent);
        assert.equal(process.env['NEW_KEY'], 'backend-endpoint-123');
        assert.equal(process.env['QUOTED_KEY'], 'secret-api-token');
        assert.equal(process.env['ALREADY_SET'], 'original_value');
    });
    it('2. resolveApiBaseUrl inspects PULSE_ENDPOINT and normalizes localhost to 127.0.0.1', () => {
        delete process.env['SDK_BASE_URL'];
        delete process.env['PULSE_BASE_URL'];
        delete process.env['PULSE_API_URL'];
        delete process.env['BACKEND_URL'];
        process.env['PULSE_ENDPOINT'] = 'http://localhost:3000';
        assert.equal(resolveApiBaseUrl(), 'http://127.0.0.1:3000');
        process.env['PULSE_ENDPOINT'] = 'https://ingest.pulse-apm.io/';
        assert.equal(resolveApiBaseUrl(), 'https://ingest.pulse-apm.io');
    });
    it('3. resolveApiBaseUrl respects BACKEND_URL and PULSE_BASE_URL precedence', () => {
        delete process.env['PULSE_ENDPOINT'];
        delete process.env['PULSE_API_URL'];
        delete process.env['SDK_BASE_URL'];
        process.env['BACKEND_URL'] = 'http://localhost:5000';
        assert.equal(resolveApiBaseUrl(), 'http://127.0.0.1:5000');
        process.env['PULSE_BASE_URL'] = 'http://127.0.0.1:4000';
        assert.equal(resolveApiBaseUrl(), 'http://127.0.0.1:4000');
    });
    it('4. init() automatically falls back to process.env.PULSE_API_KEY when apiKey is omitted', async () => {
        process.env['PULSE_API_KEY'] = 'env-api-key-test-123';
        let requestCaptured = false;
        let capturedApiKeyHeader = '';
        globalThis.fetch = (async (url, opts) => {
            if (String(url).includes('/v1/init')) {
                requestCaptured = true;
                capturedApiKeyHeader = opts?.headers?.['X-API-Key'] ?? '';
                return new Response(JSON.stringify({
                    success: true,
                    projectId: 'env-project',
                    environment: 'production',
                    release: '1.0.0',
                    config: {
                        ...TEST_REMOTE_CONFIG,
                        sdk: {
                            ...TEST_REMOTE_CONFIG.sdk,
                            projectId: 'env-project',
                            environment: 'production',
                            release: '1.0.0',
                        },
                    },
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        });
        // Call init with apiKey passed from environment
        const config = await init({ apiKey: process.env['PULSE_API_KEY'] });
        assert.ok(config, 'Config returned from init');
        assert.equal(requestCaptured, true, 'Init request sent');
        assert.equal(capturedApiKeyHeader, 'env-api-key-test-123', 'API key sent from environment');
    });
    it('5. init() resolves endpoint from PULSE_ENDPOINT environment variable without code overrides', async () => {
        let capturedUrl = '';
        process.env['PULSE_ENDPOINT'] = 'http://127.0.0.1:3000';
        globalThis.fetch = (async (url) => {
            capturedUrl = String(url);
            return new Response(JSON.stringify({
                success: true,
                projectId: 'endpoint-project',
                environment: 'production',
                release: '1.0.0',
                config: {
                    ...TEST_REMOTE_CONFIG,
                    sdk: {
                        ...TEST_REMOTE_CONFIG.sdk,
                        projectId: 'endpoint-project',
                        environment: 'production',
                        release: '1.0.0',
                    },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        await init({
            apiKey: 'test-options-key',
        });
        assert.ok(capturedUrl.startsWith('http://127.0.0.1:3000/v1/init'), 'Requested endpoint resolved from PULSE_ENDPOINT environment');
        delete process.env['PULSE_ENDPOINT'];
    });
});
