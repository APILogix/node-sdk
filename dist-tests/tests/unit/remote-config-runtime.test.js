import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js';
import { ConfigApplier } from '../../src/core/config-applier.js';
import { ConfigManager } from '../../src/core/config-manager.js';
import { RemoteConfigClient } from '../../src/core/remote-config-client.js';
function config(traceRate = 0.25, generatedAt = '2026-07-30T00:00:00.000Z') {
    const routes = Object.fromEntries(Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
        name,
        { ...route, url: `https://ingest.example.test/v1/${name}` },
    ]));
    return {
        ...BAKED_IN_REMOTE_CONFIG,
        sdk: { projectId: 'project-1', service: 'orders', environment: 'production', release: '1.0.0' },
        sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, traces: traceRate },
        transport: { ...BAKED_IN_REMOTE_CONFIG.transport, routes },
        meta: { generatedAt, generatedBy: 'test-control-plane' },
        entitlements: { ...BAKED_IN_REMOTE_CONFIG.entitlements },
    };
}
function response(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
afterEach(() => ConfigManager.reset());
function initPayload(snapshot) {
    return {
        success: true,
        projectId: snapshot.sdk.projectId,
        environment: snapshot.sdk.environment,
        release: snapshot.sdk.release,
        config: snapshot,
    };
}
describe('single-source remote configuration runtime', () => {
    it('performs one header-auth /api/v1/init request and no startup config request', async () => {
        const calls = [];
        const fetchImpl = async (input, init) => {
            calls.push({
                url: String(input),
                body: JSON.parse(String(init?.body)),
                headers: init?.headers,
            });
            return response(initPayload(config()));
        };
        const remote = new RemoteConfigClient({ apiKey: 'secret-key', baseUrl: 'https://api.example.test', fetchImpl });
        const initResponse = await remote.initialize();
        ConfigManager.getInstance().initialize(remote, initResponse.config);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.url, 'https://api.example.test/api/v1/init');
        assert.deepEqual(calls[0]?.body, {});
        assert.equal(calls[0]?.headers?.['X-API-Key'], 'secret-key');
    });
    it('rejects missing or inconsistent /v1/init identity metadata', async () => {
        const snapshot = config();
        const invalidPayloads = [
            { success: true, environment: snapshot.sdk.environment, release: snapshot.sdk.release, config: snapshot },
            { success: true, projectId: snapshot.sdk.projectId, environment: '   ', release: snapshot.sdk.release, config: snapshot },
            { success: true, projectId: snapshot.sdk.projectId, environment: snapshot.sdk.environment, release: '', config: snapshot },
            { success: true, projectId: 'different-project', environment: snapshot.sdk.environment, release: snapshot.sdk.release, config: snapshot },
            { success: true, projectId: snapshot.sdk.projectId, environment: 'different-environment', release: snapshot.sdk.release, config: snapshot },
            { success: true, projectId: snapshot.sdk.projectId, environment: snapshot.sdk.environment, release: 'different-release', config: snapshot },
        ];
        for (const payload of invalidPayloads) {
            const remote = new RemoteConfigClient({
                apiKey: 'key',
                baseUrl: 'https://api.example.test',
                fetchImpl: async () => response(payload),
            });
            await assert.rejects(() => remote.initialize(), /Init response/);
        }
    });
    it('does nothing for change:false and refreshes once for concurrent change:true signals', async () => {
        let sdkConfigCalls = 0;
        let releaseRefresh;
        const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
        const fetchImpl = async (input) => {
            const url = String(input);
            if (url.endsWith('/v1/init')) {
                return response(initPayload(config(0.25)));
            }
            sdkConfigCalls++;
            await refreshGate;
            return response(config(0.75, '2026-07-30T00:01:00.000Z'));
        };
        const remote = new RemoteConfigClient({ apiKey: 'key', baseUrl: 'https://api.example.test', fetchImpl });
        const initial = await remote.initialize();
        const manager = ConfigManager.getInstance();
        manager.initialize(remote, initial.config);
        manager.handleTelemetryResponse(202, { status: 202, change: false });
        manager.handleTelemetryResponse(500, { status: 202, change: true });
        manager.handleTelemetryResponse(200, { status: 201, change: true });
        assert.equal(sdkConfigCalls, 0);
        manager.handleTelemetryResponse(202, { status: 202, change: true });
        manager.handleTelemetryResponse(202, { status: 202, change: true });
        manager.handleTelemetryResponse(202, { status: 202, change: true });
        assert.equal(sdkConfigCalls, 1);
        releaseRefresh();
        await manager.waitForRefresh();
        assert.equal(manager.getConfig().sampling.traces, 0.75);
    });
    it('atomically freezes a replacement and applies only changed sections', async () => {
        const next = config(0.9, '2026-07-30T00:02:00.000Z');
        const fetchImpl = async (input) => String(input).endsWith('/v1/init')
            ? response(initPayload(config(0.1)))
            : response(next);
        const remote = new RemoteConfigClient({ apiKey: 'key', baseUrl: 'https://api.example.test', fetchImpl });
        const initial = await remote.initialize();
        const manager = ConfigManager.getInstance();
        const before = manager.initialize(remote, initial.config);
        const applied = [];
        manager.setApplier(new ConfigApplier({
            sampling: () => { applied.push('sampling'); },
            transport: () => { applied.push('transport'); },
            features: () => { applied.push('features'); },
        }));
        manager.handleTelemetryResponse(200, { status: 202, change: true });
        await manager.waitForRefresh();
        const after = manager.getConfig();
        assert.notEqual(after, before);
        assert.equal(after.sampling.traces, 0.9);
        assert.equal(Object.isFrozen(after), true);
        assert.equal(Object.isFrozen(after.sampling), true);
        assert.deepEqual(applied, ['sampling']);
    });
    it('retains the last valid config after failure and waits for another signal before retrying', async () => {
        let refreshAttempts = 0;
        const fetchImpl = async (input) => {
            if (String(input).endsWith('/v1/init'))
                return response(initPayload(config(0.2)));
            refreshAttempts++;
            if (refreshAttempts === 1)
                return response({ error: true }, 500);
            return response(config(0.8, '2026-07-30T00:03:00.000Z'));
        };
        const remote = new RemoteConfigClient({ apiKey: 'key', baseUrl: 'https://api.example.test', fetchImpl });
        const initial = await remote.initialize();
        const manager = ConfigManager.getInstance();
        const original = manager.initialize(remote, initial.config);
        manager.handleTelemetryResponse(202, { status: 202, change: true });
        await manager.waitForRefresh();
        assert.equal(refreshAttempts, 1);
        assert.equal(manager.getConfig(), original);
        // No timer/retry loop: yielding does not produce another request.
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(refreshAttempts, 1);
        manager.handleTelemetryResponse(202, { status: 202, change: true });
        await manager.waitForRefresh();
        assert.equal(refreshAttempts, 2);
        assert.equal(manager.getConfig().sampling.traces, 0.8);
    });
});
