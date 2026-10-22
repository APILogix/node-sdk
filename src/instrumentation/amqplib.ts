/**
 * RabbitMQ / AMQP Instrumentation — auto-instrumentation for amqplib.
 *
 * Implements:
 * - Channel.publish & Channel.sendToQueue context injection
 * - Channel.consume context extraction
 * - Memory-safe binary buffer handling (zero stringification of raw payloads)
 */

import { trace, SpanKind, SpanStatusCode, propagation, context } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js'
import type { AMQPInstrumentationConfig, PrivacyCaptureConfig } from '../types/config.js'

const AMQPLIB_GUARD = Symbol.for('pulse-sdk.patch.amqplib')

export interface AMQPInstrumentationOptions {
  enabled: boolean
  captureMessageData?: boolean
}

export function createAMQPInstrumentation(
  enabled: boolean,
  _options?: Partial<AMQPInstrumentationOptions>,
  _captureConfig?: PrivacyCaptureConfig,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const amqpModule = resolveModuleSafe('amqplib')
  if (!amqpModule) return null

  let active = true

  applyIdempotentPatch(AMQPLIB_GUARD, () => {
    // Intercept connect / createChannel
    const origConnect = amqpModule.connect
    if (typeof origConnect !== 'function') return () => {}

    amqpModule.connect = async function pulseAmqpConnect(...args: any[]) {
      const conn = await origConnect.apply(this, args)
      if (!conn) return conn

      const origCreateChannel = conn.createChannel
      if (typeof origCreateChannel === 'function') {
        conn.createChannel = async function pulseCreateChannel(...chArgs: any[]) {
          const ch = await origCreateChannel.apply(this, chArgs)
          if (!ch) return ch

          // 1. Hook publish
          const origPublish = ch.publish
          if (typeof origPublish === 'function') {
            ch.publish = function pulsePublish(exchange: string, routingKey: string, content: Buffer, options: any = {}) {
              if (!active) return origPublish.call(this, exchange, routingKey, content, options)

              const tracer = trace.getTracer('@lynktrace/node-amqplib')
              const span = tracer.startSpan(`amqp.publish ${exchange || 'default'}`, {
                kind: SpanKind.PRODUCER,
                attributes: {
                  'messaging.system': 'rabbitmq',
                  'messaging.destination': exchange || 'default',
                  'messaging.rabbitmq.routing_key': routingKey,
                  'messaging.message_payload_size_bytes': Buffer.isBuffer(content) ? content.length : 0,
                },
              })

              if (!options.headers) options.headers = {}
              propagation.inject(trace.setSpan(context.active(), span), options.headers)

              try {
                const res = origPublish.call(this, exchange, routingKey, content, options)
                span.setStatus({ code: SpanStatusCode.OK })
                span.end()
                return res
              } catch (err: any) {
                span.recordException(err instanceof Error ? err : new Error(String(err)))
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
                span.end()
                throw err
              }
            }
          }

          // 2. Hook sendToQueue
          const origSendToQueue = ch.sendToQueue
          if (typeof origSendToQueue === 'function') {
            ch.sendToQueue = function pulseSendToQueue(queue: string, content: Buffer, options: any = {}) {
              if (!active) return origSendToQueue.call(this, queue, content, options)

              const tracer = trace.getTracer('@lynktrace/node-amqplib')
              const span = tracer.startSpan(`amqp.send ${queue}`, {
                kind: SpanKind.PRODUCER,
                attributes: {
                  'messaging.system': 'rabbitmq',
                  'messaging.destination': queue,
                  'messaging.message_payload_size_bytes': Buffer.isBuffer(content) ? content.length : 0,
                },
              })

              if (!options.headers) options.headers = {}
              propagation.inject(trace.setSpan(context.active(), span), options.headers)

              try {
                const res = origSendToQueue.call(this, queue, content, options)
                span.setStatus({ code: SpanStatusCode.OK })
                span.end()
                return res
              } catch (err: any) {
                span.recordException(err instanceof Error ? err : new Error(String(err)))
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
                span.end()
                throw err
              }
            }
          }

          // 3. Hook consume
          const origConsume = ch.consume
          if (typeof origConsume === 'function') {
            ch.consume = function pulseConsume(queue: string, onMessage: any, options: any) {
              if (!active || typeof onMessage !== 'function') {
                return origConsume.call(this, queue, onMessage, options)
              }

              const wrappedOnMessage = function pulseOnMessage(msg: any) {
                if (!msg) return onMessage(msg)

                const tracer = trace.getTracer('@lynktrace/node-amqplib')
                let extractedContext = context.active()
                if (msg.properties?.headers) {
                  extractedContext = propagation.extract(extractedContext, msg.properties.headers)
                }

                const span = tracer.startSpan(
                  `amqp.consume ${queue}`,
                  {
                    kind: SpanKind.CONSUMER,
                    attributes: {
                      'messaging.system': 'rabbitmq',
                      'messaging.destination': queue,
                      'messaging.message_payload_size_bytes': Buffer.isBuffer(msg.content) ? msg.content.length : 0,
                    },
                  },
                  extractedContext,
                )

                try {
                  const res = context.with(trace.setSpan(extractedContext, span), () => onMessage(msg))
                  if (res && typeof res.then === 'function') {
                    return res.then(
                      (val: any) => {
                        span.setStatus({ code: SpanStatusCode.OK })
                        span.end()
                        return val
                      },
                      (err: any) => {
                        span.recordException(err instanceof Error ? err : new Error(String(err)))
                        span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
                        span.end()
                        throw err
                      },
                    )
                  }
                  span.setStatus({ code: SpanStatusCode.OK })
                  span.end()
                  return res
                } catch (err: any) {
                  span.recordException(err instanceof Error ? err : new Error(String(err)))
                  span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
                  span.end()
                  throw err
                }
              }

              return origConsume.call(this, queue, wrappedOnMessage, options)
            }
          }

          return ch
        }
      }

      return conn
    }

    return () => {
      amqpModule.connect = origConnect
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => { active = false },
  }
}
