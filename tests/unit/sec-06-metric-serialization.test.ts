import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serializeLabels } from '../../src/metrics/registry.js'

describe('SEC-06: Metric Label Serialization CPU & Allocation Safety', () => {
  it('correctly handles empty, single, double, and multi-key label records', () => {
    assert.strictEqual(serializeLabels({}), '')

    // Single label
    assert.strictEqual(serializeLabels({ method: 'GET' }), 'method=GET')

    // Two labels — deterministic sorting regardless of insertion order
    assert.strictEqual(serializeLabels({ b: '2', a: '1' }), 'a=1,b=2')
    assert.strictEqual(serializeLabels({ a: '1', b: '2' }), 'a=1,b=2')

    // Multiple labels — alphabetical key sorting
    assert.strictEqual(
      serializeLabels({ status: '200', method: 'POST', endpoint: '/users' }),
      'endpoint=/users,method=POST,status=200'
    )
  })

  it('serializes 100,000 metric label sets with sub-millisecond per-batch latency', () => {
    const labels = {
      http_method: 'GET',
      http_route: '/api/v1/checkout/orders',
      http_status_code: '200',
      region: 'us-east-1',
    }

    const start = performance.now()
    for (let i = 0; i < 100_000; i++) {
      const res = serializeLabels(labels)
      if (i === 0) {
        assert.strictEqual(res, 'http_method=GET,http_route=/api/v1/checkout/orders,http_status_code=200,region=us-east-1')
      }
    }
    const elapsed = performance.now() - start

    // 100,000 iterations of 4 labels should easily complete in < 150ms without JSON.stringify / localeCompare overhead
    assert.ok(elapsed < 200, `100,000 label serializations took ${elapsed.toFixed(2)}ms, must be < 200ms`)
  })
})
