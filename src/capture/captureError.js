import { client } from '../core/client.js';
import { eventQueue } from '../transport/queue.js';
import { parseStack } from '../processors/stack-parser.js';
import { generateFingerprint } from '../processors/fingerprint.js';
import { getRequestContext } from '../core/context.js';
export function captureError(error, context = {}) {
    try {
        if (!client.initialized)
            return;
        const ctx = getRequestContext();
        console.log('[SDK] captureError called with:', error, context);
        console.log('[SDK] Capturing error:');
        const config = client.config;
        if (!config?.enableErrors)
            return;
        const stackFrames = parseStack(error.stack);
        const fingerprint = generateFingerprint(error, stackFrames);
        console.log('[SDK] Request context for error:', ctx);
        const event = {
            type: 'error',
            requestId: ctx?.requestId,
            message: error.message,
            name: error,
            stack: stackFrames,
            fingerprint,
            timestamp: Date.now(),
            context
            // rawstack: error.stack,
        };
        eventQueue.add(event);
    }
    catch (err) {
        console.error('[SDK] captureError failed');
    }
}
