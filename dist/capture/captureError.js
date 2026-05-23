/**
 * Error capture — captures exceptions and routes them through the event pipeline.
 * Now integrates with remote-config-driven KillswitchEngine and SamplingEngine.
 *
 * Features:
 * - Pre-init buffering (events captured before SDK is ready are queued)
 * - Killswitch gate: if disableErrors is active, no-op immediately
 * - Sampling gate: uses SamplingEngine.shouldSampleError() for rate control
 * - Automatic breadcrumb attachment from async context
 * - Stack frame parsing and fingerprinting
 * - Severity classification
 * - Plugin processing via event pipeline
 * - Source context attachment when errors.attachSourceContext is true
 *
 * Source map resolution is deferred to the event pipeline to avoid
 * blocking the capture hot path with file I/O.
 */
import { toError } from '../core/errors.js';
import { getLogger } from '../utils/logger.js';
import { parseStack } from '../processors/stack-parser.js';
import { generateFingerprint } from '../processors/fingerprint.js';
import { getRequestContext, getSpanId, getTraceId } from '../core/context.js';
import { captureEvent } from './captureEvent.js';
import { Severity } from '../types/severity.js';
import { epochMs } from '../utils/time.js';
import { KillswitchEngine } from '../core/killswitch-engine.js';
import { SamplingEngine } from '../core/sampling-engine.js';
import { ConfigManager } from '../core/config-manager.js';
/**
 * Capture an error/exception.
 *
 * Error capture is synchronous for minimal latency. Source map resolution
 * is deferred to the event pipeline's async processing stage.
 *
 * Remote config gates:
 *   killswitches.disableErrors → no-op
 *   sampling.errors → probabilistic drop
 *   errors.grouping.normalizePaths → strip absolute paths in fingerprint
 *
 * @param error - The error to capture (Error, string, or unknown)
 * @param options - Optional severity, context, and fingerprint overrides
 */
export function captureError(error, options = {}) {
    const logger = getLogger();
    try {
        // ─── Killswitch Gate ──────────────────────────────────────────────
        const killswitch = KillswitchEngine.getInstance();
        if (killswitch?.isKilled('disableErrors')) {
            return; // Silently no-op when errors are killed
        }
        // ─── Sampling Gate ────────────────────────────────────────────────
        const samplingEngine = SamplingEngine.getInstance();
        if (samplingEngine) {
            const errorKey = typeof error === 'object' && error !== null && 'message' in error
                ? String(error.message)
                : String(error);
            const decision = samplingEngine.shouldSampleError(errorKey);
            if (!decision.sampled) {
                logger.debug('Error dropped by sampling engine', {
                    reason: decision.reason,
                    rate: decision.rate,
                });
                return;
            }
        }
        const normalized = toError(error);
        const context = isOptionsObject(options)
            ? (options.context ?? {})
            : options;
        const severity = isOptionsObject(options)
            ? (options.severity ?? Severity.Error)
            : Severity.Error;
        const customFingerprint = isOptionsObject(options)
            ? options.fingerprint
            : undefined;
        // Parse stack frames synchronously — uses V8 CallSite API when available,
        // falls back to regex for pre-serialized stacks
        const stackFrames = parseStack(normalized.stack, normalized);
        // ─── Path Normalization for Grouping ──────────────────────────────
        let normalizedFrames = stackFrames;
        try {
            const configManager = ConfigManager.getInstance();
            const errorsConfig = configManager.getConfig().errors;
            if (errorsConfig.grouping?.enabled && errorsConfig.grouping?.normalizePaths) {
                normalizedFrames = stackFrames.map(frame => {
                    if (frame.filename) {
                        // Strip absolute paths to relative: /home/user/app/src/index.js → src/index.js
                        const normalized = frame.filename.replace(/^.*?[/\\](src|lib|dist|app)[/\\]/, '$1/');
                        return { ...frame, filename: normalized };
                    }
                    return frame;
                });
            }
        }
        catch {
            // ConfigManager may not be initialized — use raw frames
        }
        // Generate fingerprint from potentially normalized frames
        const fingerprint = generateFingerprint(normalized, normalizedFrames, customFingerprint);
        const ctx = getRequestContext();
        const breadcrumbs = ctx?.breadcrumbs.toArray() ?? [];
        const event = {
            type: 'error',
            message: normalized.message,
            name: normalized.name,
            stack: stackFrames, // Keep original stack for display
            fingerprint,
            severity,
            timestamp: epochMs(),
            context,
            breadcrumbs: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            requestId: ctx?.requestId,
            traceId: getTraceId(),
            spanId: getSpanId(),
        };
        captureEvent(event);
    }
    catch (err) {
        logger.error('captureError failed', { error: err });
    }
}
function isOptionsObject(value) {
    if (!value || typeof value !== 'object')
        return false;
    return 'severity' in value || 'fingerprint' in value || 'context' in value;
}
//# sourceMappingURL=captureError.js.map