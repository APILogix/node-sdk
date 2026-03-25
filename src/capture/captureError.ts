import { client } from "../core/client.js"
import { eventQueue } from "../transport/queue.js"
import { parseStack } from "../processors/stack-parser.js"
import { generateFingerprint } from "../processors/fingerprint.js"

export function captureError(
  error: Error,
  context: Record<string, any> = {}
) {
  try {
    if (!client.initialized) return

    console.log("[SDK] captureError called with:", error, context)
    console.log("[SDK] Capturing error:")
    const config = client.config
    if (!config?.enableErrors) return

    const stackFrames = parseStack(error.stack)
    const fingerprint = generateFingerprint(error, stackFrames)

    const event = {
      type: "error",
      message: error,
      name: error,
      stack: stackFrames,
      fingerprint,
      timestamp: Date.now(),
      context,
      rawstack: error.stack,
     requestId: context.requestId || null
    }

    eventQueue.add(event)

  } catch (err) {
    console.error("[SDK] captureError failed")
  }
}