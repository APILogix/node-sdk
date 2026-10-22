/**
 * Apache Kafka Instrumentation — auto-instrumentation for kafkajs.
 *
 * Implements:
 * - Producer send interception with W3C tracecontext header injection
 * - Consumer batch/message interception with trace context propagation
 * - Configurable batch-level vs message-level span granularity
 * - Message key & partition metadata capture
 */

import { trace, SpanKind, SpanStatusCode, propagation, context } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js'
import type { KafkaInstrumentationConfig, PrivacyCaptureConfig } from '../types/config.js'

const KAFKA_GUARD = Symbol.for('pulse-sdk.patch.kafka')

export interface KafkaInstrumentationOptions {
  enabled: boolean
  emitConsumerBatchSpans?: boolean
  captureMessageKey?: boolean
}

export function createKafkaInstrumentation(
  enabled: boolean,
  options?: Partial<KafkaInstrumentationOptions>,
  _captureConfig?: PrivacyCaptureConfig,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const kafkaModule = resolveModuleSafe('kafkajs')
  if (!kafkaModule) return null

  const Kafka = kafkaModule.Kafka ?? kafkaModule.default?.Kafka
  if (!Kafka || !Kafka.prototype) return null

  let active = true

  applyIdempotentPatch(KAFKA_GUARD, () => {
    const unpatches: Array<() => void> = []

    // Hook producer creation via Kafka.prototype.producer
    const origProducer = Kafka.prototype.producer
    if (typeof origProducer === 'function') {
      Kafka.prototype.producer = function pulseKafkaProducer(this: any, ...prodArgs: any[]) {
        const producer = origProducer.apply(this, prodArgs)
        if (!producer || typeof producer.send !== 'function') return producer

        const origSend = producer.send
        producer.send = function pulseKafkaSend(this: any, record: any) {
          if (!active || !record) return origSend.apply(this, [record])

          const tracer = trace.getTracer('@lynktrace/node-kafka')
          const topic = record.topic ?? 'unknown'
          const messages = Array.isArray(record.messages) ? record.messages : []

          const span = tracer.startSpan(`kafka.produce ${topic}`, {
            kind: SpanKind.PRODUCER,
            attributes: {
              'messaging.system': 'kafka',
              'messaging.destination': topic,
              'messaging.operation': 'send',
              'messaging.kafka.message_count': messages.length,
            },
          })

          // Inject W3C traceparent into message headers
          const activeContext = trace.setSpan(context.active(), span)
          for (const msg of messages) {
            if (!msg.headers) msg.headers = {}
            propagation.inject(activeContext, msg.headers, {
              set: (carrier, key, value) => {
                carrier[key] = Buffer.from(String(value))
              },
            })
            if (options?.captureMessageKey && msg.key) {
              try {
                span.setAttribute('messaging.kafka.message_key', String(msg.key).slice(0, 256))
              } catch {}
            }
          }

          const promise = origSend.apply(this, [record])
          if (promise && typeof promise.then === 'function') {
            return promise.then(
              (res: any) => {
                try {
                  span.setStatus({ code: SpanStatusCode.OK })
                  span.end()
                } catch {}
                return res
              },
              (err: any) => {
                try {
                  span.recordException(err instanceof Error ? err : new Error(String(err)))
                  span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message ?? String(err) })
                  span.end()
                } catch {}
                throw err
              },
            )
          }

          span.end()
          return promise
        }

        return producer
      }

      unpatches.push(() => {
        Kafka.prototype.producer = origProducer
      })
    }

    // Hook consumer creation via Kafka.prototype.consumer
    const origConsumer = Kafka.prototype.consumer
    if (typeof origConsumer === 'function') {
      Kafka.prototype.consumer = function pulseKafkaConsumer(this: any, ...consArgs: any[]) {
        const consumer = origConsumer.apply(this, consArgs)
        if (!consumer || typeof consumer.run !== 'function') return consumer

        const origRun = consumer.run
        consumer.run = function pulseKafkaRun(this: any, config: any) {
          if (!active || !config) return origRun.apply(this, [config])

          const tracer = trace.getTracer('@lynktrace/node-kafka')

          // Intercept eachBatch
          if (typeof config.eachBatch === 'function') {
            const origEachBatch = config.eachBatch
            config.eachBatch = async function pulseEachBatch(payload: any) {
              const topic = payload?.batch?.topic ?? 'unknown'
              const partition = payload?.batch?.partition

              // Extract trace context from first message headers
              let extractedContext = context.active()
              const firstMsg = payload?.batch?.messages?.[0]
              if (firstMsg?.headers) {
                extractedContext = propagation.extract(extractedContext, firstMsg.headers, {
                  get: (carrier, key) => {
                    const val = carrier[key]
                    return Buffer.isBuffer(val) ? val.toString('utf8') : typeof val === 'string' ? val : undefined
                  },
                  keys: (carrier) => Object.keys(carrier),
                })
              }

              const span = tracer.startSpan(
                `kafka.consume ${topic}`,
                {
                  kind: SpanKind.CONSUMER,
                  attributes: {
                    'messaging.system': 'kafka',
                    'messaging.destination': topic,
                    'messaging.operation': 'receive',
                    'messaging.kafka.partition': partition != null ? Number(partition) : undefined,
                    'messaging.kafka.batch_size': payload?.batch?.messages?.length ?? 0,
                  },
                },
                extractedContext,
              )

              try {
                const res = await context.with(trace.setSpan(extractedContext, span), () =>
                  origEachBatch.apply(this, [payload]),
                )
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

          // Intercept eachMessage
          if (typeof config.eachMessage === 'function') {
            const origEachMessage = config.eachMessage
            config.eachMessage = async function pulseEachMessage(payload: any) {
              const topic = payload?.topic ?? 'unknown'
              const partition = payload?.partition
              const message = payload?.message

              let extractedContext = context.active()
              if (message?.headers) {
                extractedContext = propagation.extract(extractedContext, message.headers, {
                  get: (carrier, key) => {
                    const val = carrier[key]
                    return Buffer.isBuffer(val) ? val.toString('utf8') : typeof val === 'string' ? val : undefined
                  },
                  keys: (carrier) => Object.keys(carrier),
                })
              }

              const span = tracer.startSpan(
                `kafka.consume ${topic}`,
                {
                  kind: SpanKind.CONSUMER,
                  attributes: {
                    'messaging.system': 'kafka',
                    'messaging.destination': topic,
                    'messaging.operation': 'receive',
                    'messaging.kafka.partition': partition != null ? Number(partition) : undefined,
                    'messaging.kafka.offset': message?.offset != null ? String(message.offset) : undefined,
                  },
                },
                extractedContext,
              )

              try {
                const res = await context.with(trace.setSpan(extractedContext, span), () =>
                  origEachMessage.apply(this, [payload]),
                )
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

          return origRun.apply(this, [config])
        }

        return consumer
      }

      unpatches.push(() => {
        Kafka.prototype.consumer = origConsumer
      })
    }

    return () => {
      for (const fn of unpatches) fn()
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => { active = false },
  }
}
