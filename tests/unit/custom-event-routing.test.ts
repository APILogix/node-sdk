import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RouteRegistry } from '../../src/transport/route-registry.js'
import { TransportRouter } from '../../src/transport/transport-router.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'
import type { SDKEvent } from '../../src/types/event.js'

describe('F-02: Custom Event Routing and Fallback Policy', () => {
  it('resolves canonical event types to their dedicated routes', () => {
    const registry = new RouteRegistry(TEST_REMOTE_CONFIG.transport)

    assert.equal(registry.resolve({ type: 'error' } as SDKEvent).route, 'errors')
    assert.equal(registry.resolve({ type: 'message' } as SDKEvent).route, 'events')
    assert.equal(registry.resolve({ type: 'event' } as any).route, 'events')
    assert.equal(registry.resolve({ type: 'span' } as SDKEvent).route, 'spans')
    assert.equal(registry.resolve({ type: 'trace' } as SDKEvent).route, 'traces')
    assert.equal(registry.resolve({ type: 'request' } as SDKEvent).route, 'requests')
    assert.equal(registry.resolve({ type: 'metric' } as SDKEvent).route, 'metrics')
    assert.equal(registry.resolve({ type: 'log' } as SDKEvent).route, 'logs')
    assert.equal(registry.resolve({ type: 'profile' } as SDKEvent).route, 'profiles')
    assert.equal(registry.resolve({ type: 'cron_checkin' } as SDKEvent).route, 'crons')
  })

  it('safely routes unrecognized custom event types to the events route', () => {
    const registry = new RouteRegistry(TEST_REMOTE_CONFIG.transport)

    const customEvent1 = { type: 'order_checkout', orderId: 'ord-9921', total: 149.99 }
    const customEvent2 = { type: 'tenant_onboarded', tenantId: 'ten-55' }

    assert.equal(registry.isCanonicalType('order_checkout'), false)
    assert.equal(registry.isCanonicalType('tenant_onboarded'), false)

    const def1 = registry.resolve(customEvent1 as any)
    assert.equal(def1.route, 'events')
    assert.ok(def1.url.includes('/events'))

    const def2 = registry.resolve(customEvent2 as any)
    assert.equal(def2.route, 'events')
    assert.ok(def2.url.includes('/events'))
  })

  it('allows TransportRouter to accept and enqueue custom events without dropping', async () => {
    const enqueuedBatches: Array<{ url: string; count: number; events: unknown[] }> = []

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const body = JSON.parse(String(init?.body || '[]'))
      enqueuedBatches.push({ url, count: body.length, events: body })
      return new Response(JSON.stringify({ accepted: body.length }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const router = await TransportRouter.initialize(
      TEST_REMOTE_CONFIG.transport,
      'test-api-key',
      mockFetch as unknown as typeof fetch,
      TEST_REMOTE_CONFIG.limits,
    )

    const customEvent = {
      type: 'custom_billing_invoice',
      invoiceId: 'inv-101',
      amount: 450,
      timestamp: Date.now(),
    } as any

    const accepted = router.send(customEvent)
    assert.equal(accepted, true)
    assert.equal(customEvent.customType, 'custom_billing_invoice')

    // Clean up
    await router.shutdown()
  })
})
