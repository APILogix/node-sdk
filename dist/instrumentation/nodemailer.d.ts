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
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';
import type { PrivacyCaptureConfig } from '../types/config.js';
export interface NodemailerInstrumentationOptions {
    enabled: boolean;
    captureSubject?: boolean;
}
export declare class NodemailerInstrumentation extends InstrumentationBase {
    private _captureConfig?;
    private _isPatched;
    private _originalSendMail;
    private _originalCreateTransport;
    constructor(config?: NodemailerInstrumentationOptions, captureConfig?: PrivacyCaptureConfig);
    protected init(): InstrumentationNodeModuleDefinition[];
    updateCaptureConfig(captureConfig?: PrivacyCaptureConfig): void;
    private _extractRecipientDomain;
    _patchNodemailer(moduleExports: any): boolean;
    _patchTransporter(transporter: any): void;
    private _unpatchNodemailer;
}
export declare function createNodemailerInstrumentation(enabled?: boolean, options?: Partial<NodemailerInstrumentationOptions>, captureConfig?: PrivacyCaptureConfig): NodemailerInstrumentation | null;
export default createNodemailerInstrumentation;
export { NodemailerInstrumentation as LynkTraceNodemailerInstrumentation, NodemailerInstrumentation as PulseNodemailerInstrumentation, };
