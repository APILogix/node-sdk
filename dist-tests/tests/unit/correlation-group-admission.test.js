import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LoadShedder } from '../../src/transport/load-shedder.js';
describe('Telemetry Correlation Group Admission', () => {
    let loadShedder;
    beforeEach(() => {
        loadShedder = new LoadShedder(() => 'HEALTHY');
    });
    it('admits all events in HEALTHY state', () => {
        const shedder = new LoadShedder(() => 'HEALTHY');
        assert.equal(shedder.shouldShed({ type: 'request', traceId: 'trace-1', eventId: 'req-1' }), false);
        assert.equal(shedder.shouldShed({ type: 'span', traceId: 'trace-1', spanId: 'span-1', eventId: 'sp-1' }), false);
        assert.equal(shedder.shouldShed({ type: 'error', traceId: 'trace-1', eventId: 'err-1' }), false);
        assert.equal(shedder.shouldShed({ type: 'metric', metricName: 'cpu', eventId: 'm-1' }), false);
        assert.equal(shedder.shouldShed({ type: 'log', level: 'info', message: 'test', eventId: 'l-1' }), false);
    });
    it('sheds P3 low-value telemetry in PRESSURED state but admits P0, P1, and P2 correlation groups', () => {
        const shedder = new LoadShedder(() => 'PRESSURED');
        assert.equal(shedder.shouldShed({ type: 'metric', metricName: 'cpu', eventId: 'm-1' }), true);
        assert.equal(shedder.shouldShed({ type: 'log', level: 'info', message: 'debug log', eventId: 'l-1' }), true);
        assert.equal(shedder.shouldShed({ type: 'request', traceId: 'trace-1', eventId: 'req-1' }), false);
        assert.equal(shedder.shouldShed({ type: 'span', traceId: 'trace-1', spanId: 'span-1', eventId: 'sp-1' }), false);
        assert.equal(shedder.shouldShed({ type: 'error', traceId: 'trace-1', eventId: 'err-1' }), false);
    });
    it('preserves error correlation group: request + spans are promoted to P1 when an error occurs in the trace', () => {
        const shedder = new LoadShedder(() => 'CRITICAL');
        const traceId = 'trace-critical-error-123';
        // 1. Error occurs first on the trace
        const errorShed = shedder.shouldShed({
            type: 'error',
            traceId,
            eventId: 'err-1',
            message: 'database connection failed',
        });
        assert.equal(errorShed, false, 'P1 error must not be shed');
        // 2. Correlated request on the same trace
        const requestEvent = {
            type: 'request',
            traceId,
            eventId: 'req-1',
            url: '/api/checkout',
        };
        const requestShed = shedder.shouldShed(requestEvent);
        assert.equal(requestShed, false, 'Correlated request must be promoted and kept with error');
        // 3. Correlated span on the same trace
        const spanEvent = {
            type: 'span',
            traceId,
            spanId: 'span-db-1',
            eventId: 'sp-1',
            name: 'pg.query',
        };
        const spanShed = shedder.shouldShed(spanEvent);
        assert.equal(spanShed, false, 'Correlated child spans must be promoted and kept with error');
    });
    it('determines non-error P2 groups deterministically: request and all spans make the same admission decision', () => {
        const shedder = new LoadShedder(() => 'CRITICAL');
        let groupsTested = 0;
        let consistentGroups = 0;
        for (let i = 0; i < 200; i++) {
            const traceId = `trace-sample-test-${i}`;
            const reqShed = shedder.shouldShed({ type: 'request', traceId, eventId: `req-${i}` });
            const span1Shed = shedder.shouldShed({ type: 'span', traceId, spanId: `s1-${i}`, eventId: `sp1-${i}` });
            const span2Shed = shedder.shouldShed({ type: 'span', traceId, spanId: `s2-${i}`, eventId: `sp2-${i}` });
            const span3Shed = shedder.shouldShed({ type: 'span', traceId, spanId: `s3-${i}`, eventId: `sp3-${i}` });
            groupsTested++;
            // Either all are kept or all are shed
            if (reqShed === span1Shed && span1Shed === span2Shed && span2Shed === span3Shed) {
                consistentGroups++;
            }
        }
        assert.equal(consistentGroups, groupsTested, 'All spans and requests in a trace must make identical admission decisions');
    });
    it('attaches degradation metadata to admitted events under pressure', () => {
        const shedder = new LoadShedder(() => 'CRITICAL');
        const event = {
            type: 'error',
            traceId: 'trace-degraded-test',
            eventId: 'err-deg-1',
            message: 'test error',
        };
        shedder.shouldShed(event);
        assert.equal(event['telemetry_degraded'], true);
        assert.equal(event['pressure_level'], 'CRITICAL');
    });
});
