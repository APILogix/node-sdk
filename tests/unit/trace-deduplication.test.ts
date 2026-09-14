import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { traceDeduplicator } from '../../src/processors/deduplicator.js'
import { processEventAsync, resetEventPipeline } from '../../src/core/event-pipeline.js'
import { init } from '../../src/core/init.js'
import { shutdown } from '../../src/core/lifecycle.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('Trace Deduplication & Pipeline Idempotency', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    resetEventPipeline()
    traceDeduplicator.reset()
    originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/v1/init')) {
        return new Response(JSON.stringify({
          success: true,
          projectId: 'trace-test-project',
          environment: 'production',
          release: '1.0.0',
          config: {
            ...TEST_REMOTE_CONFIG,
            sdk: {
              ...TEST_REMOTE_CONFIG.sdk,
              projectId: 'trace-test-project',
              environment: 'production',
              release: '1.0.0',
            },
            features: { ...TEST_REMOTE_CONFIG.features, tracing: true },
            sampling: { ...TEST_REMOTE_CONFIG.sampling, traces: 1 },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await shutdown()
  })

  it('1. Directly suppresses duplicate traceIds within suppression window', () => {
    const traceId = 'trace-dup-test-12345678'
    assert.equal(traceDeduplicator.isDuplicate(traceId), false, 'First emission must not be a duplicate')
    assert.equal(traceDeduplicator.isDuplicate(traceId), true, 'Immediate second emission must be identified as duplicate')
    assert.equal(traceDeduplicator.isDuplicate('trace-dup-test-other'), false, 'Different traceId must not be flagged as duplicate')
  })

  it('2. Pipeline drops duplicate trace document on re-export', async () => {
    await init({ apiKey: 'test-key' })

    const traceId = 'trace-pipeline-dup-test'
    const traceEvent: any = {
      type: 'trace',
      eventId: `trace_${traceId}`,
      traceId,
      rootSpan: {
        spanId: 'span-root-1',
        name: 'GET /api/test',
        startTime: 1000,
        endTime: 1050,
        duration: 50,
        children: [],
      },
      spanCount: 1,
      totalDuration: 50,
      isPartial: false,
    }

    // First emission should be admitted
    const firstResult = await processEventAsync(traceEvent)
    assert.equal(firstResult, true, 'First trace emission must be admitted')

    // Second emission with same traceId should be dropped by deduplicator
    const secondResult = await processEventAsync(traceEvent)
    assert.equal(secondResult, false, 'Pipeline must drop duplicate trace within suppression window')
  })
})
