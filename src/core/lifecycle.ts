import { flush, stopBatcher } from "../transport/batcher.js"
import { eventQueue } from "../transport/queue.js"
import { client } from "./client.js"

export async function shutdown() {
  stopBatcher()

  try {
    await flush()
  } finally {
    eventQueue.clear()
    client.clear()
  }
}

export { flush }
