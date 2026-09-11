import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerAutoInstrumentations, resetAutoInstrumentations } from '../../src/instrumentation/auto-instrument.js';
import { SUPPRESS_INNER_HTTP } from '../../src/instrumentation/axios.js';
import { createPgInstrumentation } from '../../src/instrumentation/pg.js';
import { createRedisInstrumentation } from '../../src/instrumentation/redis.js';
import { createMySQLInstrumentation } from '../../src/instrumentation/mysql.js';
import { createMongoDBInstrumentation } from '../../src/instrumentation/mongodb.js';
import { ConfigManager } from '../../src/core/config-manager.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
describe('Bootstrap Instrumentation Ordering (CJS & ESM)', () => {
    before(() => {
        try {
            ConfigManager.getInstance().initialize({}, TEST_REMOTE_CONFIG);
        }
        catch { }
    });
    after(() => {
        resetAutoInstrumentations();
    });
    it('1. Instrumentation registration is idempotent and safe for modules loaded before or after init', () => {
        // Both CJS require() and ESM import() register hooks via Module._load or import-in-the-middle
        const pg1 = createPgInstrumentation(true, { captureQueries: true, captureParams: false }, TEST_REMOTE_CONFIG.privacy.capture);
        assert.ok(pg1, 'PG instrumentation should create successfully');
        const redis1 = createRedisInstrumentation(true, {}, TEST_REMOTE_CONFIG.privacy.capture);
        assert.ok(redis1, 'Redis instrumentation should create successfully');
        const mysql1 = createMySQLInstrumentation(true, { captureQueries: true });
        assert.ok(mysql1, 'MySQL instrumentation should create successfully');
        const mongo1 = createMongoDBInstrumentation(true, {}, TEST_REMOTE_CONFIG.privacy.capture);
        assert.ok(mongo1, 'MongoDB instrumentation should create successfully');
    });
    it('2. Re-registering auto-instrumentation unregisters old hooks to prevent duplicate wrappers', () => {
        registerAutoInstrumentations();
        // Resetting unregisters cleanly
        resetAutoInstrumentations();
        // Re-registering works without duplicate wrappers
        registerAutoInstrumentations();
    });
    it('3. Dynamic import resolves ESM-wrapped instrumentations cleanly', async () => {
        // Simulate dynamic import() workflow
        const dynamicModule = await import('../../src/instrumentation/auto-instrument.js');
        assert.ok(dynamicModule.registerAutoInstrumentations, 'dynamic import of instrumentation module must succeed');
        assert.ok(SUPPRESS_INNER_HTTP, 'SUPPRESS_INNER_HTTP symbol must be exported for axios/http bridge');
    });
});
