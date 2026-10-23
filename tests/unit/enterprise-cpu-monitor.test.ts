import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CpuMonitor, cpuMonitor } from '../../src/utils/cpu-monitor.js'

describe('Enterprise CPU Monitor', () => {
  it('initializes and samples CPU usage without crashing', () => {
    const monitor = new CpuMonitor()
    const snapshot = monitor.sample()

    assert.ok(snapshot, 'snapshot should not be null')
    assert.ok(typeof snapshot.userCpuPercent === 'number', 'userCpuPercent should be a number')
    assert.ok(typeof snapshot.systemCpuPercent === 'number', 'systemCpuPercent should be a number')
    assert.ok(typeof snapshot.processCpuPercent === 'number', 'processCpuPercent should be a number')
    assert.ok(typeof snapshot.normalizedCpuPercent === 'number', 'normalizedCpuPercent should be a number')

    assert.ok(snapshot.userCpuPercent >= 0, 'userCpuPercent must be non-negative')
    assert.ok(snapshot.systemCpuPercent >= 0, 'systemCpuPercent must be non-negative')
    assert.ok(snapshot.processCpuPercent >= 0, 'processCpuPercent must be non-negative')
    assert.ok(snapshot.normalizedCpuPercent >= 0, 'normalizedCpuPercent must be non-negative')

    assert.ok(typeof snapshot.loadAverage1m === 'number', 'loadAverage1m should be a number')
    assert.ok(typeof snapshot.loadAverage5m === 'number', 'loadAverage5m should be a number')
    assert.ok(typeof snapshot.loadAverage15m === 'number', 'loadAverage15m should be a number')
  })

  it('provides a shared instance via cpuMonitor export', () => {
    assert.ok(cpuMonitor instanceof CpuMonitor, 'cpuMonitor must be an instance of CpuMonitor')
    const sample = cpuMonitor.sample()
    assert.ok(sample, 'sample from cpuMonitor must be valid')
  })
})

