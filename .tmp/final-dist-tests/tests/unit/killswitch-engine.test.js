/**
 * KillswitchEngine Unit Tests
 *
 * Validates:
 * - All 7 killswitches independently
 * - Global SDK disable
 * - Reactive subsystem shutdown/startup handlers
 * - Config hot-swap flips
 * - Idempotent operations
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KillswitchEngine } from '../../src/core/killswitch-engine.js';
const allOff = {
    disableSDK: false,
    disableTracing: false,
    disableMetrics: false,
    disableTransport: false,
    disableProfiling: false,
    disableErrors: false,
    disableLogs: false,
};
describe('KillswitchEngine', () => {
    afterEach(() => {
        KillswitchEngine.reset();
    });
    // ─── Basic State ────────────────────────────────────────────────────────
    describe('Initial State', () => {
        it('should start with all killswitches off', () => {
            const engine = KillswitchEngine.initialize(allOff);
            assert.equal(engine.isSDKDisabled(), false);
            assert.equal(engine.isKilled('disableTracing'), false);
            assert.equal(engine.isKilled('disableMetrics'), false);
            assert.equal(engine.isKilled('disableTransport'), false);
            assert.equal(engine.isKilled('disableProfiling'), false);
            assert.equal(engine.isKilled('disableErrors'), false);
            assert.equal(engine.isKilled('disableLogs'), false);
        });
        it('should start with disableSDK on when configured', () => {
            const engine = KillswitchEngine.initialize({ ...allOff, disableSDK: true });
            assert.equal(engine.isSDKDisabled(), true);
        });
        it('should be singleton', () => {
            const engine1 = KillswitchEngine.initialize(allOff);
            const engine2 = KillswitchEngine.getInstance();
            assert.ok(engine2 !== null);
            assert.equal(engine1, engine2);
        });
    });
    // ─── Individual Killswitches ────────────────────────────────────────────
    describe('Individual Killswitches', () => {
        const killswitchNames = [
            'disableTracing',
            'disableMetrics',
            'disableTransport',
            'disableProfiling',
            'disableErrors',
            'disableLogs',
        ];
        for (const name of killswitchNames) {
            it(`should report ${name} as killed when set to true`, () => {
                const config = { ...allOff, [name]: true };
                const engine = KillswitchEngine.initialize(config);
                assert.equal(engine.isKilled(name), true);
                // Other killswitches should still be off
                for (const other of killswitchNames) {
                    if (other !== name) {
                        assert.equal(engine.isKilled(other), false, `${other} should be off`);
                    }
                }
            });
        }
    });
    // ─── Reactive Subsystem Handlers ────────────────────────────────────────
    describe('Reactive Handlers', () => {
        it('should call shutdown handler when killswitch flips on', async () => {
            const engine = KillswitchEngine.initialize(allOff);
            let shutdownCalled = false;
            let startupCalled = false;
            engine.registerSubsystem('disableTracing', {
                shutdown: () => { shutdownCalled = true; },
                startup: () => { startupCalled = true; },
            });
            // Flip disableTracing to true
            await engine.handleConfigChange({}, {
                killswitches: { ...allOff, disableTracing: true },
            });
            assert.equal(shutdownCalled, true, 'shutdown should have been called');
            assert.equal(startupCalled, false, 'startup should NOT have been called');
        });
        it('should call startup handler when killswitch flips off', async () => {
            const engine = KillswitchEngine.initialize({ ...allOff, disableTracing: true });
            let startupCalled = false;
            engine.registerSubsystem('disableTracing', {
                shutdown: () => { },
                startup: () => { startupCalled = true; },
            });
            // Flip disableTracing to false
            await engine.handleConfigChange({}, {
                killswitches: allOff,
            });
            assert.equal(startupCalled, true, 'startup should have been called');
        });
        it('should not call handlers when killswitch state unchanged', async () => {
            const engine = KillswitchEngine.initialize(allOff);
            let callCount = 0;
            engine.registerSubsystem('disableTracing', {
                shutdown: () => { callCount++; },
                startup: () => { callCount++; },
            });
            // Same config — no change
            await engine.handleConfigChange({}, {
                killswitches: allOff,
            });
            assert.equal(callCount, 0, 'no handlers should be called for unchanged state');
        });
    });
    // ─── SDK Disable ────────────────────────────────────────────────────────
    describe('SDK Disable', () => {
        it('should disable SDK when disableSDK flips to true', async () => {
            const engine = KillswitchEngine.initialize(allOff);
            assert.equal(engine.isSDKDisabled(), false);
            await engine.handleConfigChange({}, {
                killswitches: { ...allOff, disableSDK: true },
            });
            assert.equal(engine.isSDKDisabled(), true);
        });
    });
    // ─── Multiple Killswitches Simultaneously ──────────────────────────────
    describe('Multiple Killswitches', () => {
        it('should handle multiple killswitches active simultaneously', () => {
            const engine = KillswitchEngine.initialize({
                ...allOff,
                disableTracing: true,
                disableMetrics: true,
                disableProfiling: true,
            });
            assert.equal(engine.isKilled('disableTracing'), true);
            assert.equal(engine.isKilled('disableMetrics'), true);
            assert.equal(engine.isKilled('disableProfiling'), true);
            assert.equal(engine.isKilled('disableErrors'), false);
            assert.equal(engine.isKilled('disableLogs'), false);
        });
    });
});
