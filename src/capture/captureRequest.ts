import { client } from "../core/client.js"
import { eventQueue } from "../transport/queue.js"
import { getLogger } from "../utils/logger.js"
import type { RequestEvent } from "../types/event.js"

export function captureRequest(event: RequestEvent) {
  if (!client.initialized) {
    getLogger().warn("captureRequest called before SDK initialization; buffering event", {
      eventType: event.type,
      requestId: event.requestId,
    })
    eventQueue.add(event)
    return
  }
  const config = client.config

  if (!config?.enablePerformance) return

  if (Math.random() > config.samplingRate) return

  eventQueue.add(event)
}
