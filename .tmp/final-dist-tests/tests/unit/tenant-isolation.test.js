import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TenantGovernor } from '../../src/core/tenant-isolation.js';
const governors = [];
function governor(overrides = {}) {
    const value = new TenantGovernor({
        enabled: true,
        maxTenantsTracked: 2,
        quotaPerWindow: 2,
        criticalReserve: 1,
        windowDurationMs: 60_000,
        ...overrides,
    });
    governors.push(value);
    return value;
}
afterEach(() => {
    for (const value of governors.splice(0))
        value.shutdown();
});
describe('TenantGovernor', () => {
    it('atomically admits up to quota and rejects the next event', () => {
        const value = governor();
        assert.equal(value.admit('tenant-a'), true);
        assert.equal(value.admit('tenant-a'), true);
        assert.equal(value.admit('tenant-a'), false);
        assert.equal(value.getStats().totalThrottled, 1);
    });
    it('reserves capacity for one critical event after normal quota', () => {
        const value = governor();
        value.admit('tenant-a');
        value.admit('tenant-a');
        assert.equal(value.admit('tenant-a', true), true);
        assert.equal(value.admit('tenant-a', true), false);
    });
    it('uses bounded LRU eviction without sorting all tenants', () => {
        const value = governor({ maxTenantsTracked: 2, quotaPerWindow: 10 });
        value.admit('tenant-a');
        value.admit('tenant-b');
        value.admit('tenant-a'); // touch A; B is oldest
        value.admit('tenant-c');
        assert.equal(value.getStats().activeTenants, 2);
    });
});
