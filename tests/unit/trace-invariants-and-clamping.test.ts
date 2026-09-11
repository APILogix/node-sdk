import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { initTracer, shutdownTracer, withSpan, startSpan } from '../../src/tracing/tracer.js'
import { getTraceAggregator, resetTraceAggregator } from '../../src/tracing/trace-aggregator.js'
import { ConfigManager } from '../../src/core/config-manager.js'
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js'

describe('Trace Invariants & Zero Timestamp Clamping', () => {
  before(() => {
    resetTraceAggregator()
    const config = {
      ...TEST_REMOTE_CONFIG,
      entitlements: {
        ...TEST_REMOTE_CONFIG.entitlements,
        customSpans: true,
        tracing: true,
      },
    }
    try {
      ConfigManager.getInstance().initialize({} as any, config)
    } catch {}
    initTracer(config as any)
  })

  after(async () => {
    await shutdownTracer()
    resetTraceAggregator()
  })

  it('1. Strict trace timing invariants: child start >= parent start, child end <= parent end, positive duration', async () => {
    let parentTraceId = ''
    let parentSpanId = ''
    let childSpanId = ''

    await withSpan('parent-operation', async (parentSpan: any) => {
      parentTraceId = parentSpan.traceId
      parentSpanId = parentSpan.spanId

      await withSpan('nested-child', async (childSpan: any) => {
        childSpanId = childSpan.spanId
        await new Promise(r => setTimeout(r, 15))
      })
    })

    const aggregator = getTraceAggregator()
    const pending = (aggregator as any).pending.get(parentTraceId)
    assert.ok(pending, 'Trace must be present in aggregator')

    const rootSpanEvent = pending.spans.get(parentSpanId)
    const childSpanEvent = pending.spans.get(childSpanId)
    assert.ok(rootSpanEvent, 'Root span event must exist')
    assert.ok(childSpanEvent, 'Child span event must exist')

    // Assert trace context integrity
    assert.equal(childSpanEvent.traceId, rootSpanEvent.traceId, 'Child must share parent traceId')
    assert.equal(childSpanEvent.parentSpanId, rootSpanEvent.spanId, 'Child parentSpanId must match parent spanId')

    // Timing invariants
    assert.ok(
      childSpanEvent.startTime >= rootSpanEvent.startTime,
      `child.startTime (${childSpanEvent.startTime}) must be >= parent.startTime (${rootSpanEvent.startTime})`
    )
    assert.ok(
      childSpanEvent.endTime <= rootSpanEvent.endTime,
      `child.endTime (${childSpanEvent.endTime}) must be <= parent.endTime (${rootSpanEvent.endTime})`
    )
    assert.ok(childSpanEvent.duration >= 10, `child duration must be >= 10ms, was ${childSpanEvent.duration}`)
    assert.ok(rootSpanEvent.duration >= childSpanEvent.duration, 'Parent duration must encompass child duration')
  })

  it('2. Proving zero timestamp clamping: raw timestamps are never silently rewritten with Math.min', async () => {
    // Audit found: Math.min(child.endTime, parentEndMs) was masking lifecycle defects.
    // Verify that the aggregator and tracer NEVER clamp child timestamps to parentEndMs.
    const aggregator = getTraceAggregator()
    const traceId = 'trace-no-clamp-test-12345678'
    const rootSpanId = 'root-clamp-001'
    const lateChildId = 'child-clamp-002'

    const rootStartTime = 1000
    const rootEndTime = 1050 // Parent ends at 1050ms
    const childStartTime = 1020
    const childRawEndTime = 1120 // Child ends at 1120ms (70ms AFTER parent!)

    aggregator.onSpanStart(traceId, rootSpanId)
    aggregator.onSpanStart(traceId, lateChildId)

    // Add root span
    aggregator.addSpan({
      traceId,
      spanId: rootSpanId,
      name: 'HTTP Handler',
      startTime: rootStartTime,
      endTime: rootEndTime,
      duration: rootEndTime - rootStartTime,
      isSampled: true,
    })
    aggregator.onSpanEnd(traceId, rootSpanId, true)

    // Add late child span with raw end time > parent end time
    aggregator.addSpan({
      traceId,
      spanId: lateChildId,
      parentSpanId: rootSpanId,
      name: 'Detached Background Task',
      startTime: childStartTime,
      endTime: childRawEndTime,
      duration: childRawEndTime - childStartTime,
      isSampled: true,
    })
    aggregator.onSpanEnd(traceId, lateChildId, false)

    // Inspect the stored span in the aggregator
    const pendingTrace = (aggregator as any).pending.get(traceId)
    assert.ok(pendingTrace, 'Trace must be pending in aggregator')

    const storedChild = pendingTrace.spans.get(lateChildId)
    assert.ok(storedChild, 'Child span must be stored')

    // CRITICAL ASSERTION: The child endTime must be EXACTLY childRawEndTime (1120).
    // It MUST NOT be clamped to rootEndTime (1050)!
    assert.equal(
      storedChild.endTime,
      childRawEndTime,
      `Child endTime (${storedChild.endTime}) was artificially clamped! Expected raw timestamp ${childRawEndTime}`
    )
    assert.notEqual(
      storedChild.endTime,
      rootEndTime,
      'Child endTime was clamped to parent endTime! Clamping is forbidden.'
    )
  })
})
