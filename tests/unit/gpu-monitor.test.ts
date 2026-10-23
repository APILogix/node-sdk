import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GpuMonitor } from '../../src/utils/gpu-monitor.js'

describe('GPU Monitor', () => {
  it('samples GPU metrics without throwing even if nvidia-smi is unavailable', async () => {
    const monitor = new GpuMonitor()
    const snapshot = await monitor.sample()

    // In non-GPU environment, snapshot is null and caching prevents re-execution
    if (snapshot !== null) {
      assert.ok(typeof snapshot.gpuCount === 'number')
      assert.ok(typeof snapshot.averageUtilizationPercent === 'number')
      assert.ok(Array.isArray(snapshot.devices))
    } else {
      assert.strictEqual(snapshot, null)
      // Second call should return null immediately from cache
      const cached = await monitor.sample()
      assert.strictEqual(cached, null)
    }
  })

  it('provides a singleton instance via getInstance()', () => {
    const inst1 = GpuMonitor.getInstance()
    const inst2 = GpuMonitor.getInstance()
    assert.strictEqual(inst1, inst2, 'GpuMonitor.getInstance() must return singleton')
  })
})

