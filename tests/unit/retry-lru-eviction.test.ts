import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BatchManager } from '../../src/transport/batch-manager.js'
import { TransportEventQueue } from '../../src/transport/transport-event-queue.js'
import { ConnectionManager } from '../../src/transport/connection-manager.js'
import { HealthMonitor } from '../../src/transport/health-monitor.js'
import type { SDKEvent } from '../../src/types/event.js'
import type { EnterpriseRoute } from '../../src/transport/route-registry.js'

const routes: EnterpriseRoute[] = ['errors', 'events', 'traces', 'spans', 'metrics', 'logs', 'profiles', 'crons', 'requests']
const limits = Object.fromEntries(routes.map(route => [route, 2])) as Record<EnterpriseRoute, number>

function createBatchManager(fetchImpl: typeof fetch) {
  const queue = new TransportEventQueue({
    route: 'errors',
    maxSize: 50,
    criticalReserve: 5,
    priority: 'high',
    overflowStrategy: 'drop_oldest',
  })
  const instance = new BatchManager({
    route: 'errors',
    definition: { route: 'errors', method: 'POST', contentType: 'application/json', url: 'https://example.test/api/v1/errors' },
    apiKey: 'test',
    queue,
    fetchImpl,
    connectionManager: new ConnectionManager({
      maxTotalConnections: 2,
      maxConnectionsPerRoute: limits,
      connectionTimeoutMs: 50,
      socketTimeoutMs: 1_000,
      connectionTTLMs: 1_000,
      idleConnectionTimeoutMs: 1_000,
    }),
    healthMonitor: new HealthMonitor(routes),
    maxBatchSize: 10,
    minBatchSize: 1,
    maxWaitTimeMs: 50,
    maxPayloadBytes: 100_000,
    socketTimeoutMs: 1_000,
    compression: 'none',
    keepAlive: false,
    retry: { enabled: true, maxRetries: 5, backoff: 'fixed', baseDelayMs: 10 },
  })
  return { instance, queue }
}

describe('F-03: Retry Bookkeeping LRU Eviction', () => {
  it('strictly updates LRU order when retried events are processed', async () => {
    const failingFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: 'service unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }

    const { instance: batchManager } = createBatchManager(failingFetch as unknown as typeof fetch)

    const eventA: SDKEvent = {
      type: 'error',
      eventId: 'evt-A',
      error: { name: 'Error', message: 'Err A' },
      timestamp: Date.now(),
    } as any

    const eventB: SDKEvent = {
      type: 'error',
      eventId: 'evt-B',
      error: { name: 'Error', message: 'Err B' },
      timestamp: Date.now(),
    } as any

    // Trigger retryOrRetain on eventA, then eventB
    ;(batchManager as any).retryOrRetain([eventA])
    ;(batchManager as any).retryOrRetain([eventB])

    const timestamps = (batchManager as any).firstAttemptTimestamps as Map<string, number>
    // Initially: evt-A was inserted first, evt-B second
    assert.deepEqual(Array.from(timestamps.keys()), ['evt-A', 'evt-B'])

    // Now re-retry evt-A -> should move evt-A to the end (MRU)
    ;(batchManager as any).retryOrRetain([eventA])
    assert.deepEqual(Array.from(timestamps.keys()), ['evt-B', 'evt-A'])

    // Test eviction under capacity overflow
    // Populate dummy keys up to MAX_TRACKED_RETRIES (5000)
    for (let i = 0; i < 5005; i++) {
      timestamps.set(`dummy-${i}`, Date.now())
    }
    // Touch evt-A again so it remains MRU
    ;(batchManager as any).retryOrRetain([eventA])

    // Eviction loop occurs during retryOrRetain
    const dummyEvictEvent: SDKEvent = {
      type: 'error',
      eventId: 'evt-trigger-evict',
      error: { name: 'Error', message: 'Trigger' },
      timestamp: Date.now(),
    } as any
    ;(batchManager as any).retryOrRetain([dummyEvictEvent])

    // Size must be bounded within MAX_TRACKED_RETRIES + safety margin
    assert.ok(timestamps.size <= 5005)
    // Most recently used evt-A must still be preserved
    assert.ok(timestamps.has('evt-A'))

    await batchManager.shutdown()
  })
})

