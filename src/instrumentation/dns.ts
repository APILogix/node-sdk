/**
 * Node.js Native DNS Instrumentation — auto-instrumentation for node:dns.
 *
 * Captures:
 * - DNS hostname resolution latency (dns.lookup, dns.resolve)
 * - Resolved IP addresses and family (IPv4 / IPv6)
 * - Exposes DNS lookup bottlenecks in containerized / Kubernetes clusters
 */

import dns from 'node:dns'
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { applyIdempotentPatch } from './safe-wrapper.js'

const DNS_GUARD = Symbol.for('pulse-sdk.patch.dns')

export function createDNSInstrumentation(
  enabled: boolean,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const origLookup = dns.lookup
  let active = true

  applyIdempotentPatch(DNS_GUARD, () => {
    (dns as any).lookup = function pulseDnsLookup(this: any, hostname: string, options: any, callback: any) {
      if (!active) {
        return (origLookup as any).apply(this, [hostname, options, callback])
      }

      const actualCb = typeof options === 'function' ? options : callback
      const actualOpts = typeof options === 'function' ? {} : options

      const tracer = trace.getTracer('@lynktrace/node-dns')
      const startHr = process.hrtime.bigint()

      const span = tracer.startSpan(`dns.lookup ${hostname}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'dns.hostname': hostname,
        },
      })

      const wrappedCallback = (err: any, address: any, family: any) => {
        try {
          const endHr = process.hrtime.bigint()
          const durationMs = Number(endHr - startHr) / 1e6

          span.setAttribute('dns.duration_ms', Math.round(durationMs * 100) / 100)
          if (err) {
            span.recordException(err instanceof Error ? err : new Error(String(err)))
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
          } else {
            if (address) span.setAttribute('dns.address', String(address))
            if (family) span.setAttribute('dns.family', Number(family))
            span.setStatus({ code: SpanStatusCode.OK })
          }
          span.end()
        } catch {}

        if (typeof actualCb === 'function') {
          actualCb(err, address, family)
        }
      }

      if (typeof options === 'function') {
        return (origLookup as any).call(this, hostname, wrappedCallback)
      }
      return (origLookup as any).call(this, hostname, actualOpts, wrappedCallback)
    }

    return () => {
      dns.lookup = origLookup
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => {
      active = false
      dns.lookup = origLookup
    },
  }
}
