import { captureRequest } from "../capture/captureRequest.js";
import { sanitizeHeaders } from "../processors/sanitizer.js";
import { randomUUID } from "crypto";
export function monitorMiddleware() {
    return function (req, res, next) {
        console.log("[SDK] Express middleware triggered for", req.method, req.originalUrl);
        const requestId = randomUUID();
        req.__sdkRequestId = requestId;
        const start = Date.now();
        const originalSend = res.send.bind(res);
        res.send = function (body) {
            const latency = Date.now() - start;
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
                    userId: req.user?.id || null,
                });
            }
            catch (err) {
                console.error("[SDK] captureRequest failed");
            }
            return originalSend(body);
        };
        next();
    };
}
