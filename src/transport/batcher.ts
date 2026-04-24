import { eventQueue } from "./queue.js"
import { sendEvents } from "./sender.js"
import { DEFAULT_BATCH_SIZE, DEFAULT_FLUSH_INTERVAL_MS } from "../constants/defaults.js"
import { getLogger, type Logger } from "../utils/logger.js"

let interval: NodeJS.Timeout | null = null
let batchSize = DEFAULT_BATCH_SIZE
let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS
let logger: Logger = getLogger()

export function startBatcher(options?: { batchSize?: number; flushIntervalMs?: number; logger?: Logger }) {
  batchSize = options?.batchSize ?? batchSize
  flushIntervalMs = options?.flushIntervalMs ?? flushIntervalMs
  logger = options?.logger ?? getLogger()

  if (interval) return

  interval = setInterval(async () => {
    const events = eventQueue.drain(batchSize)

    try {
      if (events.length === 0) return

      await sendEvents(events)
    } catch (err) {
      eventQueue.drop(events.length)
      logger.error("Batch send failed; dropping events after retry budget exhausted", {
        error: err,
        eventCount: events.length,
        deadLetterCount: eventQueue.getDeadLetterCount(),
      })
    }
  }, flushIntervalMs)
}

export async function flush() {
  while (eventQueue.size() > 0) {
    const events = eventQueue.drain(batchSize)

    try {
      await sendEvents(events)
    } catch (err) {
      eventQueue.drop(events.length)
      logger.error("Flush failed; dropping events after retry budget exhausted", {
        error: err,
        eventCount: events.length,
        deadLetterCount: eventQueue.getDeadLetterCount(),
      })
      throw err
    }
  }
}

export function stopBatcher() {
  if (!interval) return
  clearInterval(interval)
  interval = null
}
