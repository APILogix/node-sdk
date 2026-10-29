import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_REMOTE_CONFIG as BAKED_IN_REMOTE_CONFIG } from '../fixtures/remote-config.js';
import { ConfigApplier } from '../../src/core/config-applier.js';
import { ConfigManager } from '../../src/core/config-manager.js';
import { RemoteConfigClient } from '../../src/core/remote-config-client.js';
import { BACKEND_BASE_URL } from '../../src/constants/defaults.js';
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
    it('bounds startup even when fetch ignores cancellation, without retrying', async () => {
        let calls = 0;
        let signal;
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            initTimeoutMs: 20,
            initRetries: 0,
            fetchImpl: async (_input, options) => {
                calls++;
                signal = options?.signal;
                return new Promise(() => { });
            },
        });
        await assert.rejects(remote.initialize(), /timed out/);
        assert.equal(calls, 1);
        assert.equal(signal?.aborted, true);
    });
    it('includes a stalled response body in the startup deadline', async () => {
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            initTimeoutMs: 20,
            fetchImpl: async () => ({ text: () => new Promise(() => { }) }),
        });
        await assert.rejects(remote.initialize(), /timed out/);
    });
    it('retries one transient init response and returns the validated snapshot', async () => {
        let calls = 0;
        const snapshot = config();
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            initTimeoutMs: 500,
            fetchImpl: async () => {
                calls++;
                return calls === 1
                    ? response({ error: 'temporarily unavailable' }, 503)
                    : response(initPayload(snapshot));
            },
        });
        const result = await remote.initialize();
        assert.equal(calls, 2);
        assert.equal(result.config.sdk.projectId, snapshot.sdk.projectId);
    });
    it('does not retry permanent init failures', async () => {
        let calls = 0;
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            fetchImpl: async () => {
                calls++;
                return response({ error: 'invalid API key' }, 401);
            },
        });
        await assert.rejects(remote.initialize(), /Control-plane request failed/);
        assert.equal(calls, 1);
    });
    it('does not wait past the startup deadline for a Retry-After response', async () => {
        let calls = 0;
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            initTimeoutMs: 100,
            fetchImpl: async () => {
                calls++;
                return new Response(JSON.stringify({ error: 'rate limited' }), {
                    status: 429,
                    headers: { 'retry-after': '1' },
                });
            },
        });
        const startedAt = performance.now();
        await assert.rejects(remote.initialize(), /Control-plane request failed/);
        assert.ok(performance.now() - startedAt < 100, 'Retry-After must not extend init timeout');
        assert.equal(calls, 1);
    });
    it('keeps retries within the configured total startup deadline', async () => {
        let calls = 0;
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            initTimeoutMs: 100,
            fetchImpl: async () => {
                calls++;
                return new Promise(() => { });
            },
        });
        const startedAt = performance.now();
        await assert.rejects(remote.initialize(), /timed out/);
        const elapsedMs = performance.now() - startedAt;
        assert.ok(calls >= 1 && calls <= 3, `expected one bounded retry sequence, got ${calls} attempts`);
        assert.ok(elapsedMs < 200, `init retry exceeded its 100ms deadline: ${elapsedMs}ms`);
    });
    it('performs one header-auth /v1/init request and no startup config request', async () => {
        const calls = [];
        const fetchImpl = async (input, init) => {
            calls.push({
                url: String(input),
                body: JSON.parse(String(init?.body)),
                headers: init?.headers,
            });
            return response(initPayload(config()));
        };
        const remote = new RemoteConfigClient({ apiKey: 'secret-key', fetchImpl });
        const initResponse = await remote.initialize();
        ConfigManager.getInstance().initialize(remote, initResponse.config);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.url, `${BACKEND_BASE_URL}/v1/init`);
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
        const remote = new RemoteConfigClient({ apiKey: 'key', fetchImpl });
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
        const remote = new RemoteConfigClient({ apiKey: 'key', fetchImpl });
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
        const remote = new RemoteConfigClient({ apiKey: 'key', fetchImpl });
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
    it('defaults to a 10-second startup deadline when initTimeoutMs is not provided', async () => {
        const remote = new RemoteConfigClient({
            apiKey: 'key',
        });
        // Inspect private initTimeoutMs and initRetries defaults
        assert.equal(remote.initTimeoutMs, 10000);
        assert.equal(remote.initRetries, 2);
    });
    it('stops immediately on 401, 403, 404 and invalid JSON without wasting retries', async () => {
        for (const status of [401, 403, 404]) {
            let attempts = 0;
            const remote = new RemoteConfigClient({
                apiKey: 'key',
                initRetries: 2,
                fetchImpl: async () => {
                    attempts++;
                    return response({ error: 'fatal' }, status);
                },
            });
            await assert.rejects(remote.initialize(), /Control-plane request failed/);
            assert.equal(attempts, 1, `Status ${status} must not be retried`);
        }
        let jsonAttempts = 0;
        const remoteBadJson = new RemoteConfigClient({
            apiKey: 'key',
            initRetries: 2,
            fetchImpl: async () => {
                jsonAttempts++;
                return new Response('<html>Error</html>', {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                });
            },
        });
        await assert.rejects(remoteBadJson.initialize(), /was not valid JSON/);
        assert.equal(jsonAttempts, 1, 'Invalid JSON must not be retried');
    });
    it('retries with randomized jitter on transient 500 errors', async () => {
        let attempts = 0;
        const snapshot = config();
        const delays = [];
        let lastTime = performance.now();
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            initTimeoutMs: 2500,
            initRetries: 2,
            fetchImpl: async () => {
                attempts++;
                const now = performance.now();
                delays.push(now - lastTime);
                lastTime = now;
                if (attempts < 3)
                    return response({ error: 'temporary outage' }, 500);
                return response(initPayload(snapshot));
            },
        });
        const result = await remote.initialize();
        assert.equal(attempts, 3);
        assert.equal(result.config.sdk.projectId, snapshot.sdk.projectId);
        // The retry delays should reflect base delay (>50ms) with backoff and jitter
        assert.ok(delays[1] >= 50, `Delay between attempt 1 and 2 (${delays[1]}ms) must be >= 50ms`);
    });
    it('triggers a background refresh when telemetry ACK returns config_u: true', async () => {
        let refreshCalls = 0;
        const snapshot = config(0.2);
        const updatedSnapshot = config(0.9, '2026-07-30T00:05:00.000Z');
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            fetchImpl: async (input) => {
                if (String(input).endsWith('/v1/init'))
                    return response(initPayload(snapshot));
                refreshCalls++;
                return response(updatedSnapshot);
            },
        });
        const initial = await remote.initialize();
        const manager = ConfigManager.getInstance();
        manager.initialize(remote, initial.config);
        // Telemetry response carrying config_u: true
        manager.handleTelemetryResponse(202, { success: true, accepted: 10, batchId: 'b-1', config_u: true });
        await manager.waitForRefresh();
        assert.equal(refreshCalls, 1);
        assert.equal(manager.getConfig().sampling.traces, 0.9);
    });
    it('handles server returning same: true or HTTP 304 without errors or mutation', async () => {
        let fetchCalls = 0;
        let capturedHeaders;
        const snapshot = config(0.3);
        const snapshotWithRev = {
            ...snapshot,
            meta: { ...snapshot.meta, configRevision: 7 },
        };
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            fetchImpl: async (input, init) => {
                if (String(input).endsWith('/v1/init'))
                    return response(initPayload(snapshotWithRev));
                fetchCalls++;
                capturedHeaders = init?.headers;
                // Return same: true
                return response({ success: true, same: true, configRevision: 7 });
            },
        });
        const initial = await remote.initialize();
        const manager = ConfigManager.getInstance();
        manager.initialize(remote, initial.config);
        // Signal refresh via telemetry
        manager.handleTelemetryResponse(202, { success: true, change: true });
        await manager.waitForRefresh();
        assert.equal(fetchCalls, 1);
        // Verify client sent X-Config-Revision and X-Config-Hash / If-None-Match
        const headers = capturedHeaders;
        assert.equal(headers['X-Config-Revision'], '7');
        assert.ok(headers['If-None-Match']?.startsWith('sha256:'));
        assert.ok(headers['X-Config-Hash']?.startsWith('sha256:'));
        // Config must remain identical and intact
        assert.equal(manager.getConfig().sampling.traces, 0.3);
        assert.equal(manager.getConfigRevision(), 7);
    });
    it('triggers refresh automatically via unref TTL timer when configured', async () => {
        let refreshCalls = 0;
        const snapshot = config(0.1);
        const snapshotWithTtl = {
            ...snapshot,
            runtime: { configTtlSeconds: 1 }, // 1 second TTL
            meta: { ...snapshot.meta, configRevision: 1 },
        };
        const updated = config(0.7, '2026-07-30T00:10:00.000Z');
        const remote = new RemoteConfigClient({
            apiKey: 'key',
            fetchImpl: async (input) => {
                if (String(input).endsWith('/v1/init'))
                    return response(initPayload(snapshotWithTtl));
                refreshCalls++;
                return response(updated);
            },
        });
        const initial = await remote.initialize();
        const manager = ConfigManager.getInstance();
        manager.initialize(remote, initial.config);
        // Wait 1.2s for the TTL timer to fire
        await new Promise(resolve => setTimeout(resolve, 1200));
        await manager.waitForRefresh();
        assert.equal(refreshCalls, 1);
        assert.equal(manager.getConfig().sampling.traces, 0.7);
    });
});
