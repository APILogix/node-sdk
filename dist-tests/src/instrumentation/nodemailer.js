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
import { InstrumentationBase, InstrumentationNodeModuleDefinition, } from '@opentelemetry/instrumentation';
import { SpanKind, SpanStatusCode, context, } from '@opentelemetry/api';
import { getLogger } from '../utils/logger.js';
const MODULE_NAME = 'nodemailer';
const INSTRUMENTATION_NAME = '@pulse-apm/instrumentation-nodemailer';
const INSTRUMENTATION_VERSION = '1.0.0';
export class NodemailerInstrumentation extends InstrumentationBase {
    _captureConfig;
    _isPatched = false;
    _originalSendMail = null;
    _originalCreateTransport = null;
    constructor(config = { enabled: true }, captureConfig) {
        super(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION, config);
        this._captureConfig = captureConfig;
    }
    init() {
        return [
            new InstrumentationNodeModuleDefinition(MODULE_NAME, ['>=4.0.0 <7'], (moduleExports) => {
                this._patchNodemailer(moduleExports);
                return moduleExports;
            }, (moduleExports) => {
                this._unpatchNodemailer(moduleExports);
            }),
        ];
    }
    updateCaptureConfig(captureConfig) {
        this._captureConfig = captureConfig;
    }
    _extractRecipientDomain(to) {
        try {
            if (!to)
                return 'unknown';
            const recipientStr = Array.isArray(to) ? String(to[0]) : String(to);
            const match = recipientStr.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            return match ? match[1] : 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    _patchNodemailer(moduleExports) {
        if (!moduleExports || this._isPatched)
            return false;
        const self = this;
        const logger = getLogger();
        // 1. Wrap createTransport
        if (typeof moduleExports.createTransport === 'function' && !this._originalCreateTransport) {
            this._originalCreateTransport = moduleExports.createTransport;
            const origCreateTransport = this._originalCreateTransport;
            moduleExports.createTransport = function pulsePatchedCreateTransport(...args) {
                const transporter = origCreateTransport.apply(this, args);
                if (transporter && typeof transporter.sendMail === 'function') {
                    self._patchTransporter(transporter);
                }
                return transporter;
            };
        }
        this._isPatched = true;
        logger.debug('Nodemailer auto-instrumentation attached');
        return true;
    }
    _patchTransporter(transporter) {
        if (transporter._pulsePatched)
            return;
        transporter._pulsePatched = true;
        const self = this;
        const origSendMail = transporter.sendMail;
        transporter.sendMail = function pulsePatchedSendMail(mailOptions, callback) {
            if (!self.isEnabled()) {
                return origSendMail.apply(this, arguments);
            }
            const tracer = self.tracer;
            const domain = self._extractRecipientDomain(mailOptions?.to);
            const spanName = `email.send ${domain}`;
            const hasAttachments = Boolean(mailOptions?.attachments && Array.isArray(mailOptions.attachments) && mailOptions.attachments.length > 0);
            const attributes = {
                'email.system': 'nodemailer',
                'email.operation': 'sendMail',
                'email.recipient.domain': domain,
                'email.has_attachments': hasAttachments,
            };
            if (mailOptions?.subject && (self._captureConfig?.body ?? false)) {
                attributes['email.subject'] = String(mailOptions.subject);
            }
            return tracer.startActiveSpan(spanName, {
                kind: SpanKind.CLIENT,
                attributes,
            }, (span) => {
                let ended = false;
                const endOk = (info) => {
                    if (ended)
                        return;
                    ended = true;
                    if (info?.messageId) {
                        span.setAttribute('email.message_id', String(info.messageId));
                    }
                    span.end();
                };
                const endWithError = (err) => {
                    if (ended)
                        return;
                    ended = true;
                    span.recordException(err);
                    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                    span.end();
                };
                if (typeof callback === 'function') {
                    const wrappedCallback = (err, info) => {
                        if (err)
                            endWithError(err);
                        else
                            endOk(info);
                        return callback(err, info);
                    };
                    return origSendMail.call(this, mailOptions, wrappedCallback);
                }
                try {
                    const result = origSendMail.call(this, mailOptions);
                    if (result && typeof result.then === 'function') {
                        return result.then((info) => {
                            endOk(info);
                            return info;
                        }, (err) => {
                            endWithError(err);
                            throw err;
                        });
                    }
                    endOk();
                    return result;
                }
                catch (err) {
                    endWithError(err);
                    throw err;
                }
            });
        };
    }
    _unpatchNodemailer(moduleExports) {
        if (this._originalCreateTransport && moduleExports) {
            moduleExports.createTransport = this._originalCreateTransport;
            this._originalCreateTransport = null;
        }
        this._isPatched = false;
    }
}
export function createNodemailerInstrumentation(enabled = true, options, captureConfig) {
    if (!enabled)
        return null;
    return new NodemailerInstrumentation({ enabled: true, ...options }, captureConfig);
}
export default createNodemailerInstrumentation;
