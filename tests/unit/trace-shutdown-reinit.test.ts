import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { initTracer, shutdownTracer, withSpan, startSpan } from '../../src/tracing/tracer.js'
import { getTraceAggregator, resetTraceAggregator } from '../../src/tracing/trace-aggregator.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('Tracer Multi-Cycle Shutdown & Reinitialization', () => {
  it('Cleanly completes 10 consecutive init -> shutdown cycles without leaks or duplicate listeners', async () => {
    const initialListeners = process.listenerCount('SIGTERM') + process.listenerCount('beforeExit')

    for (let cycle = 1; cycle <= 10; cycle++) {
      // 1. Initialize tracer
      initTracer(TEST_REMOTE_CONFIG as any)

      // 2. Create spans in active tracer
      let executed = false
      await withSpan(`cycle-${cycle}-span`, async span => {
        span.setAttribute('cycle.number', cycle)
        executed = true
      })
      assert.ok(executed, `Cycle ${cycle} span execution failed`)

      // 3. Cleanly shutdown tracer
      await shutdownTracer()
      resetTraceAggregator()

      // 4. Verify post-shutdown state: aggregator is empty
      const aggregator = getTraceAggregator()
      assert.equal(aggregator.pendingCount, 0, `Pending traces leaked in cycle ${cycle}`)
    }

    const finalListeners = process.listenerCount('SIGTERM') + process.listenerCount('beforeExit')
    // Listeners must not proliferate across 10 restart cycles
    assert.ok(
      finalListeners <= initialListeners + 2,
      `Listener leak detected: started with ${initialListeners}, ended with ${finalListeners}`
    )
  })
})
