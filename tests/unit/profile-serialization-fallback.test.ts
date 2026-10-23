import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SerializationPool } from '../../src/transport/serialization-pool.js'
import { BatchManager } from '../../src/transport/batch-manager.js'
import { TransportEventQueue } from '../../src/transport/transport-event-queue.js'
import { ConnectionManager } from '../../src/transport/connection-manager.js'
import { HealthMonitor } from '../../src/transport/health-monitor.js'
import type { RouteDefinition } from '../../src/transport/route-registry.js'
import type { ProfileEvent, MetricEvent } from '../../src/types/event.js'

describe('F-01: Profile Serialization Main-Thread Fallback Protection', () => {
  beforeEach(async () => {
    await SerializationPool.reset()
  })

  afterEach(async () => {
    await SerializationPool.reset()
  })

  it('refuses synchronous main-thread fallback for heavy profiles when worker is destroyed/unavailable', async () => {
    const pool = new SerializationPool(0) // 0 workers = forces fallback path

    const profileEvent: ProfileEvent = {
      type: 'profile',
      eventId: 'prof-test-123',
      profileType: 'cpu',
      startTime: Date.now() - 1000,
      endTime: Date.now(),
      duration: 1000,
      profile: { nodes: new Array(500).fill({ id: 1, callFrame: { functionName: 'busy', scriptId: '1' } }) },
      timestamp: Date.now(),
    }

    await assert.rejects(
      async () => {
        await pool.serializeBatch({
          events: [profileEvent],
          route: 'profiles',
          compression: 'gzip',
        })
      },
      (err: Error) => {
        assert.match(err.message, /main-thread fallback rejected to avoid event-loop stall/)
        return true
      }
    )
  })

  it('allows ordinary telemetry to safely use main-thread fallback when worker is unavailable', async () => {
    const pool = new SerializationPool(0) // 0 workers = forces fallback path

    const metricEvent: MetricEvent = {
      type: 'metric',
      eventId: 'metric-test-123',
      metricName: 'http.requests',
      metricType: 'counter',
      value: 1,
      timestamp: Date.now(),
    }

    const result = await pool.serializeBatch({
      events: [metricEvent],
      route: 'metrics',
      compression: 'gzip',
    })

    assert.ok(result.buffer.length > 0, 'Buffer should be non-empty')
    assert.strictEqual(result.tooLarge, false)
    assert.strictEqual(result.algorithm, 'gzip')
  })

  it('ensures BatchManager drops failed profile batches cleanly without looping or stalling', async () => {
    // Initialize pool with 0 workers so serializeBatch rejects for profiles
    SerializationPool.initialize(0)

    const routeDef: RouteDefinition = {
      route: 'profiles',
      method: 'POST',
      contentType: 'application/json',
      url: 'http://127.0.0.1:9999/v1/profiles',
    }

    const dropped: any[] = []
    const queue = new TransportEventQueue({
      route: 'profiles',
      maxSize: 100,
      criticalReserve: 10,
      priority: 'low',
      overflowStrategy: 'drop_oldest',
      onDrop: info => dropped.push(info),
    })

    const connManager = new ConnectionManager({
      maxTotalConnections: 10,
      maxConnectionsPerRoute: { profiles: 5 } as any,
      connectionTimeoutMs: 1000,
      socketTimeoutMs: 1000,
      connectionTTLMs: 5000,
      idleConnectionTimeoutMs: 5000,
    })

    const healthMonitor = new HealthMonitor(['profiles'] as any)

    const batchManager = new BatchManager({
      route: 'profiles',
      definition: routeDef,
      apiKey: 'test-key',
      queue,
      connectionManager: connManager,
      healthMonitor,
      maxBatchSize: 5,
      minBatchSize: 1,
      maxWaitTimeMs: 100,
      maxPayloadBytes: 4 * 1024 * 1024,
      socketTimeoutMs: 1000,
      compression: 'gzip',
      keepAlive: true,
      retry: { enabled: true, maxRetries: 3, backoff: 'fixed', baseDelayMs: 50 },
      onDrop: info => dropped.push(info),
    })

    const profileEvents: ProfileEvent[] = [
      {
        type: 'profile',
        eventId: 'p-1',
        profileType: 'cpu',
        startTime: Date.now() - 500,
        endTime: Date.now(),
        duration: 500,
        profile: {},
        timestamp: Date.now(),
      },
      {
        type: 'profile',
        eventId: 'p-2',
        profileType: 'cpu',
        startTime: Date.now() - 500,
        endTime: Date.now(),
        duration: 500,
        profile: {},
        timestamp: Date.now(),
      },
    ]

    for (const ev of profileEvents) {
      batchManager.enqueue(ev)
    }

    // Force flush
    await batchManager.flush()

    const stats = batchManager.getStats()
    assert.strictEqual(stats.totalDropped, 2, 'Both profiles should be dropped cleanly')
    assert.strictEqual(stats.queuedEvents, 0, 'Queue should be empty; no infinite requeue loop')
    assert.ok(dropped.some(d => d.reason === 'serialization_failed'), 'Drop reason must be serialization_failed')

    await batchManager.shutdown(100)
  })
})

