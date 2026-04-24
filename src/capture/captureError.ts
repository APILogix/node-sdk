import { client } from '../core/client.js'
import { eventQueue } from '../transport/queue.js'
import { parseStack } from '../processors/stack-parser.js'
import { generateFingerprint } from '../processors/fingerprint.js'
import { getRequestContext } from '../core/context.js'
import { getLogger } from '../utils/logger.js'
import { toError } from '../core/errors.js'

export function captureError(error: unknown, context: Record<string, unknown> = {}) {
    const logger = getLogger()

    try {
        const normalized = toError(error)

        if (!client.initialized) {
            logger.warn('captureError called before SDK initialization; buffering event', {
                errorName: normalized.name,
                errorMessage: normalized.message,
            })
            eventQueue.add(createErrorEvent(normalized, context))
            return
        }

        const ctx = getRequestContext()

        const config = client.config
        if (!config?.enableErrors) return

        const event = createErrorEvent(normalized, context, ctx?.requestId)

        eventQueue.add(event)
    } catch (err) {
        logger.error('captureError failed', { error: err })
    }
}

function createErrorEvent(error: Error, context: Record<string, unknown>, requestId?: string) {
    const stackFrames = parseStack(error.stack)
    const fingerprint = generateFingerprint(error, stackFrames)

    return {
        type: 'error',
        requestId,
        message: error.message,
        name: error.name,
        stack: stackFrames,
        fingerprint,
        timestamp: Date.now(),
        context
    }
}
