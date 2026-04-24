import type { Request, Response, NextFunction } from 'express'
import { captureRequest } from '../capture/captureRequest.js'
import { sanitizeHeaders } from '../processors/sanitizer.js'
import { randomUUID } from 'crypto'
import { asyncLocalStorage } from '../core/context.js'
import { getLogger } from '../utils/logger.js'

export function monitorMiddleware() {
    return function (req: Request, res: Response, next: NextFunction) {
        const logger = getLogger()
        const requestId = randomUUID()

        asyncLocalStorage.run({ requestId }, () => {
            const start = Date.now()
            let captured = false

            const captureOnce = (body?: any) => {
                if (captured) return
                captured = true
                const latency = Date.now() - start

                try {
                    captureRequest({
                        type: 'request',
                        requestId,
                        url: req.originalUrl,
                        method: req.method,
                        statusCode: res.statusCode,
                        latency,
                        timestamp: Date.now(),

                        headers: sanitizeHeaders(req.headers),
                        query: req.query,
                        bodySize: getBodySize(body),

                        // optional user data
                        userId: (req as any).user?.id || null
                    })
                } catch (err) {
                    logger.error('captureRequest failed', { error: err, requestId })
                }
            }

            const originalSend = res.send.bind(res)
            res.send = function (body?: any) {
                captureOnce(body)
                return originalSend(body)
            }

            res.once('finish', () => captureOnce())
            res.once('close', () => captureOnce())

            next()
        })
    }
}

function getBodySize(body: unknown) {
    if (body === undefined || body === null) return 0
    if (Buffer.isBuffer(body)) return body.length
    if (typeof body === 'string') return Buffer.byteLength(body)

    try {
        return Buffer.byteLength(JSON.stringify(body))
    } catch {
        return 0
    }
}
