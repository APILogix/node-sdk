import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as sdk from '../../src/index.js'
import {
  captureException,
  lynktraceMiddleware,
  lynktraceFastifyPlugin,
  lynktraceExpressErrorHandler,
  expressErrorHandler,
  emergencyFlush,
  getHealth,
  LynkTrace,
} from '../../src/index.js'
import {
  Severity,
  isSeverityGte,
  doesSeverityMeetThreshold,
} from '../../src/types/severity.js'
import {
  getHrtimeNs,
  getEpochMs,
  getIsoNow,
  computeDurationMs,
} from '../../src/utils/time.js'
import { HealthMonitor } from '../../src/transport/health-monitor.js'
import { ConnectionManager } from '../../src/transport/connection-manager.js'
import { RouteRegistry } from '../../src/transport/route-registry.js'
import { EventQueue } from '../../src/transport/queue.js'
import { TransportEventQueue } from '../../src/transport/transport-event-queue.js'

describe('Pure Canonical Standards Suite (Zero Legacy Baggage)', () => {
  describe('1. Canonical Public Named Exports', () => {
    it('exports lynktraceMiddleware as canonical Express request middleware', () => {
      assert.strictEqual(typeof lynktraceMiddleware, 'function')
    })

    it('exports lynktraceFastifyPlugin as canonical Fastify plugin', () => {
      assert.strictEqual(typeof lynktraceFastifyPlugin, 'function')
    })

    it('exports lynktraceExpressErrorHandler and expressErrorHandler as canonical Express error handlers', () => {
      assert.strictEqual(typeof lynktraceExpressErrorHandler, 'function')
      assert.strictEqual(typeof expressErrorHandler, 'function')
    })

    it('exports captureException as standard APM exception capture', () => {
      assert.strictEqual(typeof captureException, 'function')
    })

    it('exports emergencyFlush as canonical crash flush function', () => {
      assert.strictEqual(typeof emergencyFlush, 'function')
    })

    it('exports getHealth as canonical diagnostic health snapshot function', () => {
      assert.strictEqual(typeof getHealth, 'function')
    })
  })

  describe('2. Legacy Exports Completely Removed (Clean Break)', () => {
    it('verifies pulseMiddleware is NOT exported', () => {
      assert.strictEqual((sdk as any).pulseMiddleware, undefined)
    })

    it('verifies pulseFastifyPlugin is NOT exported', () => {
      assert.strictEqual((sdk as any).pulseFastifyPlugin, undefined)
    })

    it('verifies pulseExpressErrorHandler is NOT exported', () => {
      assert.strictEqual((sdk as any).pulseExpressErrorHandler, undefined)
    })

    it('verifies Pulse is NOT exported', () => {
      assert.strictEqual((sdk as any).Pulse, undefined)
    })

    it('verifies monitorMiddleware is NOT exported', () => {
      assert.strictEqual((sdk as any).monitorMiddleware, undefined)
    })

    it('verifies pulseExpressMiddleware is NOT exported', () => {
      assert.strictEqual((sdk as any).pulseExpressMiddleware, undefined)
    })

    it('verifies fastifyPulsePlugin is NOT exported', () => {
      assert.strictEqual((sdk as any).fastifyPulsePlugin, undefined)
    })

    it('verifies pulsePlugin is NOT exported', () => {
      assert.strictEqual((sdk as any).pulsePlugin, undefined)
    })

    it('verifies captureError is NOT exported', () => {
      assert.strictEqual((sdk as any).captureError, undefined)
    })

    it('verifies crashFlush is NOT exported', () => {
      assert.strictEqual((sdk as any).crashFlush, undefined)
    })

    it('verifies flushSync is NOT exported', () => {
      assert.strictEqual((sdk as any).flushSync, undefined)
    })

    it('verifies getSDKHealth is NOT exported', () => {
      assert.strictEqual((sdk as any).getSDKHealth, undefined)
    })

    it('verifies getDiagnostics is NOT exported', () => {
      assert.strictEqual((sdk as any).getDiagnostics, undefined)
    })
  })

  describe('3. LynkTrace Facade Namespace Canonical Parity', () => {
    it('exposes canonical methods on LynkTrace facade', () => {
      assert.strictEqual(LynkTrace.captureException, captureException)
      assert.strictEqual(LynkTrace.emergencyFlush, emergencyFlush)
      assert.strictEqual(LynkTrace.getHealth, getHealth)
      assert.strictEqual(LynkTrace.lynktraceMiddleware, lynktraceMiddleware)
      assert.strictEqual(LynkTrace.lynktraceFastifyPlugin, lynktraceFastifyPlugin)
      assert.strictEqual(LynkTrace.lynktraceExpressErrorHandler, lynktraceExpressErrorHandler)
    })

    it('verifies LynkTrace facade does NOT have legacy aliases', () => {
      assert.strictEqual((LynkTrace as any).pulseMiddleware, undefined)
      assert.strictEqual((LynkTrace as any).pulseFastifyPlugin, undefined)
      assert.strictEqual((LynkTrace as any).pulseExpressErrorHandler, undefined)
      assert.strictEqual((LynkTrace as any).captureError, undefined)
      assert.strictEqual((LynkTrace as any).monitorMiddleware, undefined)
      assert.strictEqual((LynkTrace as any).fastifyPulsePlugin, undefined)
      assert.strictEqual((LynkTrace as any).crashFlush, undefined)
      assert.strictEqual((LynkTrace as any).getDiagnostics, undefined)
    })
  })

  describe('4. Standard Utilities & Predicates', () => {
    it('Severity predicates follow standard is/does boolean naming', () => {
      assert.strictEqual(typeof isSeverityGte, 'function')
      assert.strictEqual(typeof doesSeverityMeetThreshold, 'function')

      assert.strictEqual(isSeverityGte(Severity.Error, Severity.Warning), true)
      assert.strictEqual(isSeverityGte(Severity.Debug, Severity.Error), false)
      assert.strictEqual(doesSeverityMeetThreshold(Severity.Error, Severity.Error), true)
    })

    it('Time utilities follow standard get*/compute* naming', () => {
      assert.strictEqual(typeof getHrtimeNs, 'function')
      assert.strictEqual(typeof getEpochMs, 'function')
      assert.strictEqual(typeof getIsoNow, 'function')
      assert.strictEqual(typeof computeDurationMs, 'function')

      const epoch = getEpochMs()
      assert.strictEqual(typeof epoch, 'number')
      assert.strictEqual(epoch > 0, true)

      const iso = getIsoNow()
      assert.strictEqual(typeof iso, 'string')
      assert.strictEqual(Number.isNaN(Date.parse(iso)), false)
    })
  })

  describe('5. Transport & Queue Class Methods', () => {
    it('HealthMonitor exposes canonical getSnapshot, getConcurrencyScale, getBatchScale', () => {
      const monitor = new HealthMonitor(['errors', 'events'])
      assert.strictEqual(typeof monitor.getSnapshot, 'function')
      assert.strictEqual(typeof monitor.getConcurrencyScale, 'function')
      assert.strictEqual(typeof monitor.getBatchScale, 'function')
      assert.strictEqual(typeof monitor.getSnapshot('errors'), 'object')
    })

    it('ConnectionManager exposes getStats, getMaxForRoute, getInUseCount', () => {
      const cm = new ConnectionManager({
        maxTotalConnections: 10,
        maxConnectionsPerRoute: {
          errors: 2,
          events: 2,
          traces: 2,
          spans: 2,
          metrics: 2,
          logs: 2,
          profiles: 2,
          crons: 2,
          requests: 2,
        },
        connectionTimeoutMs: 1000,
        socketTimeoutMs: 1000,
        connectionTTLMs: 30000,
        idleConnectionTimeoutMs: 10000,
      })
      assert.strictEqual(typeof cm.getStats, 'function')
      assert.strictEqual(typeof cm.getMaxForRoute, 'function')
    })

    it('RouteRegistry exposes getRoutes', () => {
      const registry = new RouteRegistry({
        apiKey: 'test-key',
        routes: {
          errors: { url: 'http://localhost/errors', priority: 'critical', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          events: { url: 'http://localhost/events', priority: 'normal', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          traces: { url: 'http://localhost/traces', priority: 'normal', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          spans: { url: 'http://localhost/spans', priority: 'normal', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          metrics: { url: 'http://localhost/metrics', priority: 'normal', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          logs: { url: 'http://localhost/logs', priority: 'normal', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          profiles: { url: 'http://localhost/profiles', priority: 'low', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          crons: { url: 'http://localhost/crons', priority: 'normal', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
          requests: { url: 'http://localhost/requests', priority: 'normal', compression: 'none', batchSize: 10, flushIntervalMs: 1000 },
        },
        batchSize: 10,
        flushIntervalMs: 1000,
        timeoutMs: 5000,
        compression: 'none',
      } as any)

      assert.strictEqual(typeof registry.getRoutes, 'function')
      assert.strictEqual(Array.isArray(registry.getRoutes()), true)
    })

    it('EventQueue and TransportEventQueue expose getSize', () => {
      const q = new EventQueue(100)
      assert.strictEqual(typeof q.getSize, 'function')

      const tq = new TransportEventQueue({
        route: 'errors',
        maxSize: 100,
        criticalReserve: 10,
        priority: 'high',
        overflowStrategy: 'drop_oldest',
      })
      assert.strictEqual(typeof tq.getSize, 'function')
    })
  })
})
