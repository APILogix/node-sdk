import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodemailerInstrumentation } from '../../src/instrumentation/nodemailer.js'

describe('Nodemailer Auto-Instrumentation', () => {
  let memoryExporter: InMemorySpanExporter
  let provider: NodeTracerProvider
  let instrumentation: NodemailerInstrumentation

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
    })
    provider.register()

    instrumentation = new NodemailerInstrumentation({ enabled: true }, { body: true } as any)
    instrumentation.setTracerProvider(provider)
  })

  afterEach(() => {
    instrumentation.disable()
    trace.disable()
  })

  it('instruments transporter.sendMail and generates email.send span with sanitized recipient domain', async () => {
    const fakeTransporter = {
      async sendMail(mailOptions: any) {
        return { messageId: '<msg-1234@domain.com>', accepted: [mailOptions.to] }
      },
    }

    instrumentation._patchTransporter(fakeTransporter)

    const result = await fakeTransporter.sendMail({
      to: 'user.sensitive+alias@customer.com',
      subject: 'Your Password Reset Token',
    })

    assert.equal(result.messageId, '<msg-1234@domain.com>')

    const spans = memoryExporter.getFinishedSpans()
    const emailSpan = spans.find((s) => s.name.startsWith('email.send'))

    assert.ok(emailSpan, 'email.send span should exist')
    assert.equal(emailSpan.kind, SpanKind.CLIENT)
    assert.equal(emailSpan.attributes['email.system'], 'nodemailer')
    assert.equal(emailSpan.attributes['email.operation'], 'sendMail')
    assert.equal(emailSpan.attributes['email.recipient.domain'], 'customer.com')
    assert.equal(emailSpan.attributes['email.message_id'], '<msg-1234@domain.com>')
    assert.equal(emailSpan.status.code, SpanStatusCode.UNSET)
  })

  it('captures errors on email dispatch failure and sets ERROR status', async () => {
    const fakeTransporter = {
      async sendMail(_mailOptions?: any) {
        throw new Error('SMTP connection timeout: host unreachable')
      },
    }

    instrumentation._patchTransporter(fakeTransporter)

    await assert.rejects(
      async () => {
        await fakeTransporter.sendMail({
          to: 'alert@monitoring.org',
          subject: 'Critical Alert',
        })
      },
      /SMTP connection timeout/
    )

    const spans = memoryExporter.getFinishedSpans()
    const emailSpan = spans.find((s) => s.name.startsWith('email.send'))

    assert.ok(emailSpan, 'email.send span should exist')
    assert.equal(emailSpan.status.code, SpanStatusCode.ERROR)
    assert.match(String(emailSpan.status.message), /SMTP connection timeout/)
  })

  it('supports callback-style transporter.sendMail', async () => {
    const fakeTransporter = {
      sendMail(mailOptions: any, cb: (err: any, info: any) => void) {
        process.nextTick(() => cb(null, { messageId: '<cb-789@example.com>' }))
      },
    }

    instrumentation._patchTransporter(fakeTransporter)

    await new Promise<void>((resolve, reject) => {
      fakeTransporter.sendMail({ to: 'dev@test.net' }, (err: any, info: any) => {
        try {
          assert.ifError(err)
          assert.equal(info.messageId, '<cb-789@example.com>')

          const spans = memoryExporter.getFinishedSpans()
          const emailSpan = spans.find((s) => s.name === 'email.send test.net')
          assert.ok(emailSpan)
          assert.equal(emailSpan.attributes['email.recipient.domain'], 'test.net')
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
  })
})
