/**
 * AWS SQS & SNS Instrumentation — auto-instrumentation for @aws-sdk/client-sqs
 * and @aws-sdk/client-sns.
 *
 * Implements:
 * - W3C tracecontext propagation via SQS/SNS MessageAttributes
 * - SendMessage, SendMessageBatch, ReceiveMessage, and Publish tracking
 */

import { trace, SpanKind, SpanStatusCode, propagation, context } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js'

const SQS_GUARD = Symbol.for('pulse-sdk.patch.sqs')
const SNS_GUARD = Symbol.for('pulse-sdk.patch.sns')

export function createSqsSnsInstrumentation(
  sqsEnabled: boolean,
  snsEnabled: boolean,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!sqsEnabled && !snsEnabled) return null

  let active = true

  // 1. SQS Patch
  if (sqsEnabled) {
    const sqsModule = resolveModuleSafe('@aws-sdk/client-sqs')
    const SQSClient = sqsModule?.SQSClient ?? sqsModule?.default?.SQSClient

    if (SQSClient?.prototype?.send) {
      applyIdempotentPatch(SQS_GUARD, () => {
        const origSend = SQSClient.prototype.send

        SQSClient.prototype.send = function pulseSqsSend(this: any, command: any, ...args: any[]) {
          if (!active || !command) return origSend.apply(this, [command, ...args])

          const commandName = command?.constructor?.name ?? ''
          if (!['SendMessageCommand', 'SendMessageBatchCommand', 'ReceiveMessageCommand'].includes(commandName)) {
            return origSend.apply(this, [command, ...args])
          }

          const tracer = trace.getTracer('@lynktrace/node-sqs')
          const queueUrl = command.input?.QueueUrl ?? 'unknown'
          const op = commandName.replace(/Command$/, '')

          const isReceive = op === 'ReceiveMessage'
          const span = tracer.startSpan(`SQS.${op}`, {
            kind: isReceive ? SpanKind.CONSUMER : SpanKind.PRODUCER,
            attributes: {
              'messaging.system': 'aws.sqs',
              'messaging.destination': queueUrl,
              'messaging.operation': isReceive ? 'receive' : 'send',
            },
          })

          // Context Injection on Send
          if (!isReceive && command.input) {
            if (!command.input.MessageAttributes) command.input.MessageAttributes = {}
            propagation.inject(trace.setSpan(context.active(), span), command.input.MessageAttributes, {
              set: (carrier, key, value) => {
                carrier[key] = { DataType: 'String', StringValue: String(value) }
              },
            })
          }

          const promise = origSend.apply(this, [command, ...args])
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

        return () => {
          SQSClient.prototype.send = origSend
        }
      })
    }
  }

  // 2. SNS Patch
  if (snsEnabled) {
    const snsModule = resolveModuleSafe('@aws-sdk/client-sns')
    const SNSClient = snsModule?.SNSClient ?? snsModule?.default?.SNSClient

    if (SNSClient?.prototype?.send) {
      applyIdempotentPatch(SNS_GUARD, () => {
        const origSend = SNSClient.prototype.send

        SNSClient.prototype.send = function pulseSnsSend(this: any, command: any, ...args: any[]) {
          if (!active || !command) return origSend.apply(this, [command, ...args])

          const commandName = command?.constructor?.name ?? ''
          if (commandName !== 'PublishCommand') {
            return origSend.apply(this, [command, ...args])
          }

          const tracer = trace.getTracer('@lynktrace/node-sns')
          const topicArn = command.input?.TopicArn ?? command.input?.TargetArn ?? 'unknown'

          const span = tracer.startSpan('SNS.Publish', {
            kind: SpanKind.PRODUCER,
            attributes: {
              'messaging.system': 'aws.sns',
              'messaging.destination': topicArn,
              'messaging.operation': 'send',
            },
          })

          if (command.input) {
            if (!command.input.MessageAttributes) command.input.MessageAttributes = {}
            propagation.inject(trace.setSpan(context.active(), span), command.input.MessageAttributes, {
              set: (carrier, key, value) => {
                carrier[key] = { DataType: 'String', StringValue: String(value) }
              },
            })
          }

          const promise = origSend.apply(this, [command, ...args])
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

        return () => {
          SNSClient.prototype.send = origSend
        }
      })
    }
  }

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => { active = false },
  }
}
