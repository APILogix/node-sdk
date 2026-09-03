import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoadShedder } from '../../src/transport/load-shedder.js';
describe('LoadShedder brownout behavior', () => {
    it('keeps a deterministic request sample during critical pressure', () => {
        const shedder = new LoadShedder(() => 'critical');
        let kept = 0;
        let shed = 0;
        for (let index = 0; index < 500; index++) {
            if (shedder.shouldShed({ type: 'request', eventId: `request-${index}` }))
                shed++;
            else
                kept++;
        }
        assert.ok(kept > 0, 'critical pressure should not block all request capture');
        assert.ok(shed > 0, 'critical pressure should still reduce request volume');
    });
    it('continues to drop low-priority telemetry during critical pressure', () => {
        const shedder = new LoadShedder(() => 'critical');
        assert.equal(shedder.shouldShed({ type: 'metric', eventId: 'metric-1' }), true);
        assert.equal(shedder.shouldShed({ type: 'log', eventId: 'log-1' }), true);
    });
    it('never drops crash telemetry during critical pressure', () => {
        const shedder = new LoadShedder(() => 'critical');
        assert.equal(shedder.shouldShed({
            type: 'error',
            eventId: 'fatal-1',
            mechanism: { type: 'uncaughtException' },
        }), false);
    });
});
