import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { attachSourceContext, resetSourceContextCache } from '../../src/processors/source-context.js'
import { parseStack } from '../../src/processors/stack-parser.js'
import type { StackFrame } from '../../src/types/event.js'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const currentFile = fileURLToPath(import.meta.url)

describe('Source Context Processor', () => {
  beforeEach(() => {
    resetSourceContextCache()
  })

  it('enriches stack frame with source context when file exists', async () => {
    const frames = parseStack(undefined, new Error('trusted test frame'))
      .filter(frame => frame.filename?.replace(/\\/g, '/').replace(/^([A-Z]):/i, '/$1:') === currentFile.replace(/\\/g, '/').replace(/^([A-Z]):/i, '/$1:'))
    assert.ok(frames.length > 0, 'V8 CallSites should include this loaded test module')

    const enriched = await attachSourceContext(frames)
    assert.equal(enriched.length, 1)
    const frame = enriched[0]
    assert.ok(frame)
    assert.ok(frame.sourceContext, 'sourceContext must be attached')
    assert.ok(Array.isArray(frame.sourceContext.pre))
    assert.ok(typeof frame.sourceContext.line === 'string')
    assert.ok(Array.isArray(frame.sourceContext.post))
  })

  it('does not read a neutral-name file from a fabricated or stale stack frame', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.tmp', 'source-context-security-'))
    const databaseFile = join(directory, 'database.js')
    await writeFile(databaseFile, 'const canary = "CANARY_SOURCE_LEAK";\n', 'utf8')

    try {
      const error = new Error('original message')
      const serializedStack = error.stack
      error.message = `changed message\n    at loadConfig (${databaseFile}:1:1)`
      const parsed = parseStack(serializedStack, error)
      assert.deepEqual(parsed, [], 'a stale serialized stack must not be parsed against a changed message')

      const fabricated: StackFrame[] = [{
        filename: databaseFile,
        lineno: 1,
        colno: 1,
        function: 'loadConfig',
        inApp: true,
      }]
      const enriched = await attachSourceContext(fabricated)
      assert.equal(enriched[0]?.sourceContext, undefined)
      assert.equal(JSON.stringify(enriched).includes('CANARY_SOURCE_LEAK'), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
