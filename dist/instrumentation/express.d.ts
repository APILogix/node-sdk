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
import type { Request, Response, NextFunction } from 'express';
export declare function monitorMiddleware(): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=express.d.ts.map