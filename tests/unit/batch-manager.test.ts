import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BatchManager } from '../../src/transport/batch-manager.js'
import { TransportEventQueue } from '../../src/transport/transport-event-queue.js'
import { ConnectionManager } from '../../src/transport/connection-manager.js'
import { HealthMonitor } from '../../src/transport/health-monitor.js'
import type { SDKEvent } from '../../src/types/event.js'
import type { EnterpriseRoute } from '../../src/transport/route-registry.js'

const routes: EnterpriseRoute[] = ['errors', 'events', 'traces', 'spans', 'metrics', 'logs', 'profiles', 'crons', 'requests', 'replays']
const limits = Object.fromEntries(routes.map(route => [route, 2])) as Record<EnterpriseRoute, number>

function event(id: string): SDKEvent {
  return { type: 'error', eventId: id, timestamp: Date.now(), message: id, severity: 'error' } as SDKEvent
}

function manager(fetchImpl: typeof fetch) {
  const queue = new TransportEventQueue({ route: 'errors', maxSize: 20, priority: 'high' })
  const instance = new BatchManager({
    route: 'errors',
    definition: { route: 'errors', endpoint: '/api/v1/errors', method: 'POST', contentType: 'application/json', url: 'https://example.test/api/v1/errors' },
    apiKey: 'test', queue, fetchImpl,
    connectionManager: new ConnectionManager({ maxTotalConnections: 2, maxConnectionsPerRoute: limits, connectionTimeoutMs: 50, socketTimeoutMs: 1_000, connectionTTLMs: 1_000, idleConnectionTimeoutMs: 1_000 }),
    healthMonitor: new HealthMonitor(routes),
    maxBatchSize: 1, minBatchSize: 1, maxWaitTimeMs: 5,
    maxPayloadBytes: 100_000, socketTimeoutMs: 1_000,
    retry: { enabled: true, maxRetries: 2, backoff: 'fixed', baseDelayMs: 1 },
  })
  return { instance, queue }
}

describe('BatchManager concurrency and shutdown', () => {
  let keepAlive: ReturnType<typeof setInterval>
  before(() => { keepAlive = setInterval(() => undefined, 1_000) })
  after(() => clearInterval(keepAlive))

  it('shares tracked retry work across concurrent flushes', async () => {
    let calls = 0
    const { instance, queue } = manager(async () => new Response('', { status: ++calls === 1 ? 503 : 200 }))
    instance.enqueue(event('retry-1'))
    await Promise.all([instance.flush(), instance.flush()])
    assert.equal(calls, 2)
    assert.equal(queue.size(), 0)
    assert.equal(instance.stats().totalRetries, 1)
    assert.equal(instance.stats().totalSent, 1)
  })

  it('aborts an active fetch and retains the event during shutdown', async () => {
    let started!: () => void
    const fetchStarted = new Promise<void>(resolve => { started = resolve })
    const fetchImpl: typeof fetch = async (_url, options) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const { instance, queue } = manager(fetchImpl)
    instance.enqueue(event('blocked-1'))
    await fetchStarted
    const residual = await instance.shutdown(100)
    assert.deepEqual(residual, [])
    assert.deepEqual(queue.drain(10).map(item => item.eventId), ['blocked-1'])
  })

  it('hands a non-cooperative active fetch back as bounded residual', async () => {
    let started!: () => void
    const fetchStarted = new Promise<void>(resolve => { started = resolve })
    const { instance } = manager(async () => {
      started()
      return new Promise<Response>(() => undefined)
    })
    instance.enqueue(event('residual-1'))
    await fetchStarted
    const beganAt = Date.now()
    const residual = await instance.shutdown(20)
    assert.ok(Date.now() - beganAt < 500)
    assert.deepEqual(residual.map(item => item.eventId), ['residual-1'])
  })
})
