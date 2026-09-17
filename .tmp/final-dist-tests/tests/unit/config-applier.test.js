import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigApplier } from '../../src/core/config-applier.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
function snapshot(overrides) {
    return { ...TEST_REMOTE_CONFIG, ...overrides };
}
test('a non-transport limit change does not rebuild transport', async () => {
    const calls = [];
    const applier = new ConfigApplier({
        limits: () => { calls.push('limits'); },
        transport: () => { calls.push('transport'); },
    });
    const next = snapshot({
        limits: { ...TEST_REMOTE_CONFIG.limits, maxSpanAttributes: 50 },
    });
    const diff = applier.diff(TEST_REMOTE_CONFIG, next);
    await applier.apply(diff, TEST_REMOTE_CONFIG, next);
    assert.deepEqual(calls, ['limits']);
});
test('payload and transport changes rebuild transport exactly once', async () => {
    const calls = [];
    const applier = new ConfigApplier({
        limits: () => { calls.push('limits'); },
        transport: () => { calls.push('transport'); },
    });
    const next = snapshot({
        limits: { ...TEST_REMOTE_CONFIG.limits, maxPayloadSize: 131_072 },
        transport: {
            ...TEST_REMOTE_CONFIG.transport,
            keepAlive: !TEST_REMOTE_CONFIG.transport.keepAlive,
        },
    });
    const diff = applier.diff(TEST_REMOTE_CONFIG, next);
    await applier.apply(diff, TEST_REMOTE_CONFIG, next);
    assert.deepEqual(calls, ['limits', 'transport']);
});
test('handler failure does not block an independent changed section', async () => {
    const calls = [];
    const applier = new ConfigApplier({
        sampling: () => { calls.push('sampling'); throw new Error('isolated failure'); },
        features: () => { calls.push('features'); },
    });
    const next = snapshot({
        sampling: { ...TEST_REMOTE_CONFIG.sampling, traces: 0.5 },
        features: { ...TEST_REMOTE_CONFIG.features, tracing: true },
    });
    const diff = applier.diff(TEST_REMOTE_CONFIG, next);
    await applier.apply(diff, TEST_REMOTE_CONFIG, next);
    assert.deepEqual(calls, ['sampling', 'features']);
});
