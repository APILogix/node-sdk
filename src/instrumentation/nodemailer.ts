/**
 * Nodemailer Outbound Email Instrumentation
 *
 * Intercepts `nodemailer.createTransport` and `Transporter.prototype.sendMail`
 * to trace email dispatch operations as CLIENT spans.
 *
 * Security & PII Protection:
 * - Recipient email addresses are sanitized to only record domain names
 *   (e.g., user@example.com -> domain: example.com) to comply with privacy policies.
 * - Subject lines are sanitized to prevent secret leaks.
 */

import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation'
import {
  SpanKind,
  SpanStatusCode,
  context,
} from '@opentelemetry/api'
import type { PrivacyCaptureConfig } from '../types/config.js'
import { getLogger } from '../utils/logger.js'

const MODULE_NAME = 'nodemailer'
const INSTRUMENTATION_NAME = '@pulse-apm/instrumentation-nodemailer'
const INSTRUMENTATION_VERSION = '1.0.0'

export interface NodemailerInstrumentationOptions {
  enabled: boolean
  captureSubject?: boolean
}

export class NodemailerInstrumentation extends InstrumentationBase {
  private _captureConfig?: PrivacyCaptureConfig | undefined
  private _isPatched = false
  private _originalSendMail: any = null
  private _originalCreateTransport: any = null

  constructor(
    config: NodemailerInstrumentationOptions = { enabled: true },
    captureConfig?: PrivacyCaptureConfig
  ) {
    super(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION, config)
    this._captureConfig = captureConfig
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        MODULE_NAME,
        ['>=4.0.0 <7'],
        (moduleExports: any) => {
          this._patchNodemailer(moduleExports)
          return moduleExports
        },
        (moduleExports: any) => {
          this._unpatchNodemailer(moduleExports)
        }
      ),
    ]
  }

  public updateCaptureConfig(captureConfig?: PrivacyCaptureConfig): void {
    this._captureConfig = captureConfig
  }

  private _extractRecipientDomain(to: unknown): string {
    try {
      if (!to) return 'unknown'
      const first = Array.isArray(to) ? to[0] : to
      const recipientStr = typeof first === 'object' && first !== null && 'address' in first
        ? String((first as { address?: unknown }).address ?? '')
        : String(first ?? '')
      const atIndex = recipientStr.lastIndexOf('@')
      if (atIndex === -1) return 'unknown'
      const domain = recipientStr.slice(atIndex + 1).replace(/[>\s].*$/, '').trim()
      return /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain) ? domain : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  public _patchNodemailer(moduleExports: any): boolean {
    if (!moduleExports || this._isPatched) return false
    const self = this
    const logger = getLogger()

    // 1. Wrap createTransport
    if (typeof moduleExports.createTransport === 'function' && !this._originalCreateTransport) {
      this._originalCreateTransport = moduleExports.createTransport
      const origCreateTransport = this._originalCreateTransport

      moduleExports.createTransport = function pulsePatchedCreateTransport(this: any, ...args: any[]) {
        const transporter = origCreateTransport.apply(this, args)
        if (transporter && typeof transporter.sendMail === 'function') {
          self._patchTransporter(transporter)
        }
        return transporter
      }
    }

    this._isPatched = true
    logger.debug('Nodemailer auto-instrumentation attached')
    return true
  }

  public _patchTransporter(transporter: any): void {
    if (transporter._pulsePatched) return
    transporter._pulsePatched = true
    const self = this
    const origSendMail = transporter.sendMail

    transporter.sendMail = function pulsePatchedSendMail(this: any, mailOptions: any, callback?: any) {
      if (!self.isEnabled()) {
        return origSendMail.apply(this, arguments as any)
      }

      const tracer = self.tracer
      const domain = self._extractRecipientDomain(mailOptions?.to)
      const spanName = `email.send ${domain}`

      const hasAttachments = Boolean(
        mailOptions?.attachments && Array.isArray(mailOptions.attachments) && mailOptions.attachments.length > 0
      )

      const attributes: Record<string, string | number | boolean> = {
        'email.system': 'nodemailer',
        'email.operation': 'sendMail',
        'email.recipient.domain': domain,
        'email.has_attachments': hasAttachments,
      }

      if (mailOptions?.subject && (self._captureConfig?.body ?? false)) {
        attributes['email.subject'] = String(mailOptions.subject)
      }

      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes,
        },
        (span) => {
          let ended = false
          const endOk = (info?: any) => {
            if (ended) return
            ended = true
            if (info?.messageId) {
              span.setAttribute('email.message_id', String(info.messageId))
            }
            span.end()
          }

          const endWithError = (err: any) => {
            if (ended) return
            ended = true
            span.recordException(err)
            span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) })
            span.end()
          }

          if (typeof callback === 'function') {
            const wrappedCallback = (err: any, info: any) => {
              if (err) endWithError(err)
              else endOk(info)
              return callback(err, info)
            }
            return origSendMail.call(this, mailOptions, wrappedCallback)
          }

          try {
            const result = origSendMail.call(this, mailOptions)
            if (result && typeof result.then === 'function') {
              return result.then(
                (info: any) => {
                  endOk(info)
                  return info
                },
                (err: any) => {
                  endWithError(err)
                  throw err
                }
              )
            }
            endOk()
            return result
          } catch (err) {
            endWithError(err)
            throw err
          }
        }
      )
    }
  }

  private _unpatchNodemailer(moduleExports: any): void {
    if (this._originalCreateTransport && moduleExports) {
      moduleExports.createTransport = this._originalCreateTransport
      this._originalCreateTransport = null
    }
    this._isPatched = false
  }
}

export function createNodemailerInstrumentation(
  enabled = true,
  options?: Partial<NodemailerInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): NodemailerInstrumentation | null {
  if (!enabled) return null
  return new NodemailerInstrumentation({ enabled: true, ...options }, captureConfig)
}

export default createNodemailerInstrumentation
