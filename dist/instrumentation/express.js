/**
 * Express middleware — automatic request instrumentation.
 *
 * Features:
 * - Per-request async context with trace/span correlation
 * - Automatic breadcrumb creation for HTTP requests
 * - Response capture via monkey-patched res.send()
 * - Body size measurement
 * - Error capture on request failure
 */
import { captureRequest } from '../capture/captureRequest.js';
import { sanitizeHeaders } from '../processors/sanitizer.js';
import { generateId } from '../utils/uuid.js';
import { createContextStore, withContext, addBreadcrumb } from '../core/context.js';
import { getLogger } from '../utils/logger.js';
import { client } from '../core/client.js';
export function monitorMiddleware() {
    return function (req, res, next) {
        const logger = getLogger();
        const requestId = generateId();
        const maxBreadcrumbs = client.initialized ? client.config.maxBreadcrumbs : 100;
        const store = createContextStore(requestId, maxBreadcrumbs);
        withContext(store, () => {
            const start = Date.now();
            let captured = false;
            // Add initial breadcrumb for the request
            addBreadcrumb({
                category: 'http',
                message: `${req.method} ${req.originalUrl}`,
                type: 'http',
                data: {
                    method: req.method,
                    url: req.originalUrl,
                },
            });
            const captureOnce = (body) => {
                if (captured)
                    return;
                captured = true;
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
                        bodySize: getBodySize(body),
                        userId: (req.user)?.id ?? null,
                    });
                }
                catch (err) {
                    logger.error('captureRequest failed', {
                        error: err,
                        requestId,
                        endpoint: req.originalUrl,
                        method: req.method,
                        statusCode: res.statusCode,
                    });
                }
            };
            const originalSend = res.send.bind(res);
            res.send = function (body) {
                captureOnce(body);
                return originalSend(body);
            };
            res.once('finish', () => captureOnce());
            res.once('close', () => captureOnce());
            next();
        });
    };
}
function getBodySize(body) {
    if (body === undefined || body === null)
        return 0;
    if (Buffer.isBuffer(body))
        return body.length;
    if (typeof body === 'string')
        return Buffer.byteLength(body);
    try {
        return Buffer.byteLength(JSON.stringify(body));
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=express.js.map