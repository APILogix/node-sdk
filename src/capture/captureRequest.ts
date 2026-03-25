import { client } from "../core/client.js"
import { eventQueue } from "../transport/queue.js"

export function captureRequest(event:any) {
  if (!client.initialized) return
  const config = client.config

  if (!config?.enablePerformance) return

  // Sampling
  if (Math.random() > config.samplingRate) return

 
  eventQueue.add(event)

}