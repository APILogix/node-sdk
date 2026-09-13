import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyScopeToEvent } from '../../src/core/scope.js';
import { createContextStore, withContext } from '../../src/core/context.js';
describe('Worker Serialization & Structured Clone Safety', () => {
    it('omits function and symbol properties when merging extra into telemetry events', () => {
        const rawRes = { statusCode: 200 };
        const rawReq = { method: 'POST', url: '/api/checkout' };
        const extra = {
            tenantId: 'tenant-enterprise-1',
            regularField: 'safeValue',
            // Explicit function properties that previously caused DataCloneError:
            getStatusCode: () => rawRes.statusCode,
            getMethod: () => rawReq.method,
            getUrl: () => rawReq.url,
            customCallback: () => 'do-not-clone',
        };
        const store = createContextStore('req-test-1', 10, {
            extra,
            tags: { framework: 'express' },
        });
        withContext(store, () => {
            const rawEvent = {
                type: 'error',
                eventId: 'err-test-clone-01',
                message: 'Something went wrong',
            };
            const enriched = applyScopeToEvent(rawEvent);
            // 1. Legitimate data properties must be preserved
            assert.ok(enriched['extra'], 'enriched event should have extra');
            const enrichedExtra = enriched['extra'];
            assert.equal(enrichedExtra['tenantId'], 'tenant-enterprise-1');
            assert.equal(enrichedExtra['regularField'], 'safeValue');
            // 2. Functions must NEVER be present in enriched extra
            assert.equal(enrichedExtra['getStatusCode'], undefined);
            assert.equal(enrichedExtra['getMethod'], undefined);
            assert.equal(enrichedExtra['getUrl'], undefined);
            assert.equal(enrichedExtra['customCallback'], undefined);
            assert.equal(typeof enrichedExtra['getStatusCode'], 'undefined');
            // 3. Must be 100% cloneable by V8 Structured Clone Algorithm (used by worker.postMessage)
            assert.doesNotThrow(() => {
                structuredClone(enriched);
            }, 'enriched event must pass structuredClone without DataCloneError');
        });
    });
    it('verifies non-enumerable getters on extra are hidden from enumeration but callable', () => {
        const res = { statusCode: 201 };
        const extra = { tenantId: 'tenant-123' };
        Object.defineProperties(extra, {
            getStatusCode: { value: () => res.statusCode, enumerable: false, configurable: true },
            getMethod: { value: () => 'GET', enumerable: false, configurable: true },
        });
        // Property lookup works (used by captureError)
        assert.equal(typeof extra.getStatusCode, 'function');
        assert.equal(extra.getStatusCode(), 201);
        // Not enumerated by Object.entries or spread
        const entries = Object.entries(extra);
        assert.equal(entries.length, 1);
        assert.equal(entries[0][0], 'tenantId');
        const clonedSpread = { ...extra };
        assert.equal(clonedSpread['getStatusCode'], undefined);
    });
});
