import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getLogger, setDebugMode, setLogLevel, setLogFormat } from '../../src/utils/logger.js'
import { Severity } from '../../src/types/severity.js'

describe('SEC-09: Noisy INFO Logging Overhead Verification', () => {
  let stdoutChunks: string[] = []
  let originalStdoutWrite: typeof process.stdout.write

  beforeEach(() => {
    stdoutChunks = []
    originalStdoutWrite = process.stdout.write
    process.stdout.write = ((chunk: any) => {
      stdoutChunks.push(String(chunk))
      return true
    }) as any
  })

  afterEach(() => {
    process.stdout.write = originalStdoutWrite
    setDebugMode(false)
  })

  it('suppresses routine debug logs under production default log level (Severity.Info)', () => {
    setDebugMode(false) // production default
    const logger = getLogger()

    logger.debug('[TransportRouter] Batch captured', { count: 10 })
    logger.debug('[TransportRouter] Sending batch', { count: 10 })
    logger.debug('[TransportRouter] Batch send successful', { count: 10 })
    logger.debug('[RemoteConfigClient] Control-plane request started')

    assert.strictEqual(stdoutChunks.length, 0, 'Routine debug telemetry transport logs must not write to stdout in production')
  })

  it('outputs diagnostic logs when debugMode is explicitly enabled', () => {
    setDebugMode(true)
    const logger = getLogger()

    logger.debug('[TransportRouter] Batch captured', { count: 10 })
    assert.ok(stdoutChunks.length > 0, 'Debug logs must be emitted when debug mode is enabled')
    assert.ok(stdoutChunks.some(chunk => chunk.includes('[TransportRouter] Batch captured')))
  })
})
