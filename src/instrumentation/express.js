import { captureRequest } from '../capture/captureRequest.js';
import { sanitizeHeaders } from '../processors/sanitizer.js';
import { randomUUID } from 'crypto';
import { asyncLocalStorage } from '../core/context.js';
export function monitorMiddleware() {
    return function (req, res, next) {
        console.log('[SDK] Express middleware triggered for', req.method, req.originalUrl);
        const requestId = randomUUID();
        console.log("[SDK] setting requestId:", requestId);
        //  req._sdkRequestId = requestId // attach requestId to req for later use
        asyncLocalStorage.run({ requestId }, () => {
            const start = Date.now();
            const originalSend = res.send.bind(res);
            res.send = function (body) {
                const latency = Date.now() - start;
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
                        bodySize: body ? Buffer.byteLength(body) : 0,
                        // optional user data
                        userId: req.user?.id || null
                    });
                }
                catch (err) {
                    console.error('[SDK] captureRequest failed');
                }
                return originalSend(body);
            };
            next();
        });
    };
}
