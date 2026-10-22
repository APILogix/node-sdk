/**
 * Google Cloud Pub/Sub Instrumentation — auto-instrumentation for @google-cloud/pubsub.
 */

import { trace, SpanKind, SpanStatusCode, propagation, context } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js'

const PUBSUB_GUARD = Symbol.for('pulse-sdk.patch.pubsub')

export function createPubSubInstrumentation(
  enabled: boolean,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const pubsubModule = resolveModuleSafe('@google-cloud/pubsub')
  const Topic = pubsubModule?.Topic ?? pubsubModule?.default?.Topic

  if (!Topic?.prototype?.publishMessage) return null

  let active = true

  applyIdempotentPatch(PUBSUB_GUARD, () => {
    const origPublish = Topic.prototype.publishMessage

    Topic.prototype.publishMessage = function pulsePubSubPublish(this: any, message: any, ...args: any[]) {
      if (!active || !message) return origPublish.apply(this, [message, ...args])

      const tracer = trace.getTracer('@lynktrace/node-pubsub')
      const topicName = this.name ?? 'unknown'

      const span = tracer.startSpan(`pubsub.publish ${topicName}`, {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'gcp.pubsub',
          'messaging.destination': topicName,
          'messaging.operation': 'send',
        },
      })

      if (!message.attributes) message.attributes = {}
      propagation.inject(trace.setSpan(context.active(), span), message.attributes)

      const promise = origPublish.apply(this, [message, ...args])
      if (promise && typeof promise.then === 'function') {
        return promise.then(
          (messageId: any) => {
            try {
              if (messageId) {
                span.setAttribute('messaging.message_id', String(messageId))
              }
              span.setStatus({ code: SpanStatusCode.OK })
              span.end()
            } catch {}
            return messageId
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

    return () => {
      Topic.prototype.publishMessage = origPublish
    }
  })

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => { active = false },
  }
}
