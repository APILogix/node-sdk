import assert from 'node:assert/strict';
import { init } from '../../../src/core/init.js';
import { shutdown } from '../../../src/core/lifecycle.js';
import { client } from '../../../src/core/client.js';
import { ConfigManager } from '../../../src/core/config-manager.js';
import { FeatureController } from '../../../src/core/feature-controller.js';
import { RemoteConfigMockServer } from './mock-server.js';
/**
 * Resets all SDK state, shuts down active background workers and flushes telemetry,
 * restoring global singletons to a pristine uninitialized state.
 */
export async function resetSdkState() {
    let result = {
        completed: true,
        timedOut: false,
        durationMs: 0,
        remainingEvents: 0,
        deadLetterCount: 0,
        stepErrors: [],
    };
    if (client.initialized || client.options !== null) {
        try {
            result = await shutdown(4_000);
        }
        catch {
            // Best-effort shutdown
        }
    }
    ConfigManager.reset();
    client.clear();
    return result;
}
/**
 * High-level setup utility to start from a clean state and initialize the SDK
 * pointing to the active mock server.
 */
export async function setupTestSdk(server, customOptions = {}) {
    await resetSdkState();
    return await init({
        apiKey: 'test-e2e-api-key',
        debug: false,
        ...customOptions,
    });
}
/**
 * Convenience alias for initializing SDK with mock server.
 */
export async function initSdkForTest(server, options = {}) {
    return await init({
        apiKey: 'test-e2e-api-key',
        debug: false,
        ...options,
    });
}
/**
 * Scoped lifecycle runner that starts a RemoteConfigMockServer, executes the test
 * callback, and guarantees clean teardown of both SDK and server in finally.
 */
export async function withMockServer(testFn, options = {}) {
    const server = await RemoteConfigMockServer.start(options);
    try {
        await testFn(server, server.url);
    }
    finally {
        try {
            await shutdown(2_000);
        }
        catch { }
        ConfigManager.reset();
        client.clear();
        await server.stop();
    }
}
/**
 * Asynchronously polls a condition predicate with timeout and customizable interval.
 */
export async function waitForCondition(predicate, timeoutMs = 5_000, intervalMs = 25, failureMessage = 'Condition was not satisfied within timeout') {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate())
            return;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`${failureMessage} (exceeded ${timeoutMs}ms)`);
}
/**
 * Captures a baseline snapshot of process-level listeners and handles.
 */
export function captureProcessBaseline() {
    const proc = process;
    const mem = process.memoryUsage();
    const sigtermCount = process.listeners('SIGTERM').length;
    const sigintCount = process.listeners('SIGINT').length;
    const uncaughtCount = process.listeners('uncaughtException').length;
    const unhandledCount = process.listeners('unhandledRejection').length;
    const activeHandles = proc._getActiveHandles?.().length ?? 0;
    const activeRequests = proc._getActiveRequests?.().length ?? 0;
    return {
        sigtermCount,
        sigintCount,
        uncaughtCount,
        unhandledCount,
        activeHandles,
        activeRequests,
        heapUsedBytes: mem.heapUsed,
        rssBytes: mem.rss,
        sigtermListeners: sigtermCount,
        sigintListeners: sigintCount,
        uncaughtListeners: uncaughtCount,
        unhandledListeners: unhandledCount,
    };
}
export function takeProcessSnapshot() {
    return captureProcessBaseline();
}
/**
 * Verifies that the current process state has not leaked signal listeners or handles
 * compared to the baseline snapshot.
 */
export function assertNoProcessLeaks(baseline, current, label = 'Process') {
    const now = current ?? captureProcessBaseline();
    const expectedSigterm = baseline.sigtermListeners ?? baseline.sigtermCount;
    const actualSigterm = now.sigtermListeners ?? now.sigtermCount;
    assert.equal(actualSigterm, expectedSigterm, `${label}: SIGTERM listener leak (baseline: ${expectedSigterm}, now: ${actualSigterm})`);
    const expectedSigint = baseline.sigintListeners ?? baseline.sigintCount;
    const actualSigint = now.sigintListeners ?? now.sigintCount;
    assert.equal(actualSigint, expectedSigint, `${label}: SIGINT listener leak (baseline: ${expectedSigint}, now: ${actualSigint})`);
    const expectedUncaught = baseline.uncaughtListeners ?? baseline.uncaughtCount;
    const actualUncaught = now.uncaughtListeners ?? now.uncaughtCount;
    assert.equal(actualUncaught, expectedUncaught, `${label}: uncaughtException listener leak (baseline: ${expectedUncaught}, now: ${actualUncaught})`);
    const expectedUnhandled = baseline.unhandledListeners ?? baseline.unhandledCount;
    const actualUnhandled = now.unhandledListeners ?? now.unhandledCount;
    assert.equal(actualUnhandled, expectedUnhandled, `${label}: unhandledRejection listener leak (baseline: ${expectedUnhandled}, now: ${actualUnhandled})`);
}
// ─── Assertion Utilities ───────────────────────────────────────────────────
export function assertSdkState(expectedInitialized) {
    assert.equal(client.initialized, expectedInitialized, `SDK initialized state must be ${expectedInitialized}, got ${client.initialized}`);
}
export function assertFeatureStatus(featureId, expectedEnabled) {
    const controller = FeatureController.getInstance();
    if (!controller) {
        if (expectedEnabled) {
            assert.fail(`FeatureController is not initialized, expected ${featureId} to be enabled`);
        }
        return;
    }
    const isEnabled = controller.isEnabled(featureId);
    assert.equal(isEnabled, expectedEnabled, `Feature "${featureId}" enabled status must be ${expectedEnabled}, got ${isEnabled}`);
}
export function assertEventMatches(actual, expected) {
    for (const [key, expectedVal] of Object.entries(expected)) {
        const actualVal = actual[key];
        if (typeof expectedVal === 'object' && expectedVal !== null) {
            assert.deepEqual(actualVal, expectedVal, `Event field '${key}' mismatch`);
        }
        else {
            assert.equal(actualVal, expectedVal, `Event field '${key}' mismatch`);
        }
    }
}
export function assertValidBatchHeaders(record, expectedRoute) {
    assert.equal(record.headers['content-type'], 'application/json', `Content-Type must be application/json, got ${record.headers['content-type']}`);
    assert.equal(record.headers['x-pulse-internal'], '1', `x-pulse-internal header must be '1', got ${record.headers['x-pulse-internal']}`);
    assert.ok(record.headers['authorization']?.startsWith('Bearer '), `Authorization header must be a Bearer token, got ${record.headers['authorization']}`);
    assert.equal(record.headers['x-route'], expectedRoute, `X-Route header must be '${expectedRoute}', got ${record.headers['x-route']}`);
    if (expectedRoute !== 'crons') {
        assert.equal(record.headers['content-encoding'], 'gzip', `Telemetry batch for ${expectedRoute} must be gzip-compressed, got ${record.headers['content-encoding']}`);
    }
}
export function assertAuthHeader(record, expectedKey = 'test-e2e-api-key') {
    const apiKeyHeader = record.headers['x-api-key'];
    const authHeader = record.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const receivedKey = apiKeyHeader || bearerToken;
    assert.equal(receivedKey, expectedKey, `Expected API key "${expectedKey}", got "${receivedKey}"`);
}
export function assertGzipCompressed(record) {
    assert.equal(record.headers['content-encoding'], 'gzip', `Expected Content-Encoding: gzip, got ${record.headers['content-encoding']}`);
    assert.ok(record.rawBody.length > 0, 'Compressed raw body must not be empty');
}
export function assertUncompressed(record) {
    assert.ok(!record.headers['content-encoding'] || record.headers['content-encoding'] === 'identity', `Expected uncompressed payload, got Content-Encoding: ${record.headers['content-encoding']}`);
}
export async function assertTelemetryEventReceived(server, route, eventMatcher, timeoutMs = 5_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const requests = server.getRequests(route);
        for (const req of requests) {
            if (req.events.some(eventMatcher))
                return req;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Telemetry event matching predicate was not received on route "${route}" within ${timeoutMs}ms`);
}
