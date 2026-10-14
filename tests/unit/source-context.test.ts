import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { attachSourceContext, resetSourceContextCache } from '../../src/processors/source-context.js'
import type { StackFrame } from '../../src/types/event.js'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)

describe('Source Context Processor', () => {
  beforeEach(() => {
    resetSourceContextCache()
  })

  it('enriches stack frame with source context when file exists', async () => {
    const frames: StackFrame[] = [
      {
        filename: currentFile,
        lineno: 10,
        colno: 1,
        function: 'testFn',
        inApp: true,
      },
    ]

    const enriched = await attachSourceContext(frames)
    assert.equal(enriched.length, 1)
    const frame = enriched[0]
    assert.ok(frame)
    assert.ok(frame.sourceContext, 'sourceContext must be attached')
    assert.ok(Array.isArray(frame.sourceContext.pre))
    assert.ok(typeof frame.sourceContext.line === 'string')
    assert.ok(Array.isArray(frame.sourceContext.post))
  })

  it('bounds negative cache under high volume of missing file paths', async () => {
    // Generate 1200 non-existent file paths with allowed extensions
    const frames: StackFrame[] = Array.from({ length: 1200 }, (_, i) => ({
      filename: `C:/virtual/project/missing_module_${i}.ts`,
      lineno: 15,
      colno: 4,
      function: 'nonExistent',
      inApp: true,
    }))

    const enriched = await attachSourceContext(frames)
    assert.equal(enriched.length, 1200)
    for (const frame of enriched) {
      assert.equal(frame.sourceContext, undefined, 'missing files should not have sourceContext')
    }

    // Ensure resetSourceContextCache runs cleanly
    resetSourceContextCache()
  })
})
