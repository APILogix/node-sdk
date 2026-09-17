import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersistenceGovernor } from '../../src/storage/persistence-governor.js';
function logEvent(id) {
    return {
        type: 'log',
        eventId: id,
        level: 'info',
        message: 'test',
        timestamp: Date.now(),
    };
}
describe('PersistenceGovernor', () => {
    it('honors remote-config budget updates at runtime', () => {
        const governor = new PersistenceGovernor({
            maxPersistPerMinute: 1,
            enableAdaptive: false,
            budgetExceededLogIntervalMs: 60_000,
        });
        assert.equal(governor.shouldPersist(logEvent('evt-1')), true);
        assert.equal(governor.shouldPersist(logEvent('evt-2')), false);
        governor.configure({
            maxPersistPerMinute: 2,
            adaptive: false,
            budgetExceededLogIntervalMs: 60_000,
        });
        assert.equal(governor.shouldPersist(logEvent('evt-3')), true);
        assert.equal(governor.shouldPersist(logEvent('evt-4')), false);
    });
});
