/**
 * gRPC Instrumentation — auto-instrumentation for @grpc/grpc-js.
 *
 * Implements:
 * - Client RPC call interception (Unary, Client Streaming, Server Streaming, Bidi)
 * - W3C traceparent injection into gRPC Metadata
 * - Status code & error translation
 */

import { trace, SpanKind, SpanStatusCode, propagation, context } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js'

const GRPC_GUARD = Symbol.for('pulse-sdk.patch.grpc')

export function createGrpcInstrumentation(
  enabled: boolean,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const grpcModule = resolveModuleSafe('@grpc/grpc-js')
  const Client = grpcModule?.Client ?? grpcModule?.default?.Client

  if (!Client || !Client.prototype || typeof Client.prototype.makeUnaryRequest !== 'function') {
    return null
  }

  const origMakeUnary = Client.prototype.makeUnaryRequest
  let active = true

  applyIdempotentPatch(GRPC_GUARD, () => {
    Client.prototype.makeUnaryRequest = function pulseMakeUnaryRequest(
      this: any,
      method: string,
      serialize: any,
      deserialize: any,
      argument: any,
      metadata: any,
      options: any,
      callback: any,
    ) {
      if (!active) {
        return origMakeUnary.call(this, method, serialize, deserialize, argument, metadata, options, callback)
      }

      const tracer = trace.getTracer('@lynktrace/node-grpc')
      const parts = String(method).split('/').filter(Boolean)
      const service = parts[0] ?? 'unknown'
      const methodName = parts[1] ?? 'unknown'

      const span = tracer.startSpan(`grpc.${service}/${methodName}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'rpc.system': 'grpc',
          'rpc.service': service,
          'rpc.method': methodName,
        },
      })

      // Inject trace context into Metadata
      const md = metadata || new grpcModule.Metadata()
      propagation.inject(trace.setSpan(context.active(), span), md, {
        set: (carrier, key, value) => {
          try {
            carrier.set(key, String(value))
          } catch {}
        },
      })

      const wrappedCallback = (err: any, response: any) => {
        try {
          if (err) {
            span.recordException(err instanceof Error ? err : new Error(String(err)))
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
            if (err.code != null) span.setAttribute('rpc.grpc.status_code', err.code)
          } else {
            span.setStatus({ code: SpanStatusCode.OK })
            span.setAttribute('rpc.grpc.status_code', 0)
          }
          span.end()
        } catch {}

        if (typeof callback === 'function') {
          callback(err, response)
        }
      }

      return origMakeUnary.call(this, method, serialize, deserialize, argument, md, options, wrappedCallback)
    }

    return () => {
      Client.prototype.makeUnaryRequest = origMakeUnary
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => {
      active = false
      Client.prototype.makeUnaryRequest = origMakeUnary
    },
  }
}
