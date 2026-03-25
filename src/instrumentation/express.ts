import type { Request, Response, NextFunction } from "express"
import { captureRequest } from "../capture/captureRequest.js"
import { sanitizeHeaders } from "../processors/sanitizer.js"
import { randomUUID } from "crypto"
export function monitorMiddleware() {
  return function (req: Request, res: Response, next: NextFunction) {
    console.log("[SDK] Express middleware triggered for", req.method, req.originalUrl)
   const requestId = randomUUID()

    // attach to request
    ;(req as any).__sdkRequestId = requestId

    const start = Date.now()

    const originalSend = res.send.bind(res)

    res.send = function (body?: any) {
      const latency = Date.now() - start
      try {
        captureRequest({
          type: "request",
          requestId,
          url: req.originalUrl,
          method: req.method,
          statusCode: res.statusCode,
          latency,
          timestamp: Date.now(),

          headers: sanitizeHeaders(req.headers),
          query: req.query,
          bodySize: body ? Buffer.byteLength(body) : 0,

         // optional user data
          userId: (req as any).user?.id || null,
        })
      } catch (err) {
        console.error("[SDK] captureRequest failed")
      }

      return originalSend(body)
    }

    next()
  }
}