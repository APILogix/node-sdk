import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveApplicationPackage } from '../../src/utils/package-metadata.js'
import { normalizeEvent } from '../../src/processors/normalizer.js'
import { SDK_NAME, SDK_VERSION } from '../../src/constants/version.js'
import type { EventMetadata, SDKEvent } from '../../src/types/event.js'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function options(packageJsonPath: string, overrides: Record<string, unknown> = {}) {
  return { apiKey: 'test', packageJsonPath, ...overrides }
}

describe('application package metadata', () => {
  it('reads only name/version and honors explicit overrides', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pulse-package-'))
    temporary.push(directory)
    const path = join(directory, 'package.json')
    writeFileSync(path, JSON.stringify({ name: 'consumer-app', version: '4.2.1', dependencies: { secret: 'x' } }))

    assert.deepEqual(resolveApplicationPackage(options(path)), {
      name: 'consumer-app', version: '4.2.1', packageJsonPath: path,
    })
    assert.equal(resolveApplicationPackage(options(path, { applicationVersion: '9.0.0' })).version, '9.0.0')
  })

  it('never throws for missing or malformed package.json', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pulse-package-'))
    temporary.push(directory)
    const path = join(directory, 'package.json')
    writeFileSync(path, '{broken')
    assert.deepEqual(resolveApplicationPackage(options(path, { applicationName: 'orders' })), {
      name: 'orders', version: '0.0.0-unknown',
    })
  })
  it('attaches authoritative application and SDK versions to every event type', () => {
    const metadata: EventMetadata = {
      sdkName: SDK_NAME, sdkVersion: SDK_VERSION,
      applicationName: 'consumer-app', applicationVersion: '4.2.1',
      projectId: 'proj_123', environment: 'test', release: 'release-2026-07',
    }
    const now = Date.now()
    const events: SDKEvent[] = [
      { type: 'request', requestId: 'r', url: '/', method: 'get', statusCode: 200, latency: 1, timestamp: now },
      { type: 'error', message: 'e', name: 'Error', stack: [], fingerprint: 'f', timestamp: now, severity: 'error', context: {}, classification: { unhandled: false, fatal: false, crash: false } },
      { type: 'message', message: 'm', severity: 'info', timestamp: now },
      { type: 'metric', metricName: 'm', metricType: 'gauge', value: 1, timestamp: now },
      { type: 'span', spanId: 's', traceId: 't', name: 'span', startTime: now, endTime: now + 1, duration: 1, status: 'ok' },
      { type: 'trace', traceId: 't', rootSpan: { spanId: 's', name: 'root', startTime: now, endTime: now + 1, duration: 1, status: 'ok', children: [] }, spanCount: 1, totalDuration: 1, isPartial: false },
      { type: 'log', level: 'info', message: 'l', timestamp: now },
      { type: 'profile', profileType: 'cpu', startTime: now, endTime: now + 1, duration: 1, profile: {}, timestamp: now },
      { type: 'cron_checkin', monitorSlug: 'job', status: 'ok', timestamp: now },
    ]

    for (const event of events) {
      const normalized = normalizeEvent({ ...event, metadata: { ...metadata, applicationVersion: 'forged' } } as SDKEvent, metadata)
      assert.equal(normalized.metadata?.applicationVersion, '4.2.1', event.type)
      assert.equal(normalized.metadata?.sdkVersion, SDK_VERSION, event.type)
    }
  })
})
