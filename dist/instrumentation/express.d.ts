/**
 * Compatibility shim.
 *
 * Express tracing is provided by OpenTelemetry ExpressInstrumentation.
 * The legacy middleware remains export-compatible but does not patch response
 * methods, create spans, or capture duplicate request telemetry.
 */
import type { Request, Response, NextFunction } from 'express';
export declare function monitorMiddleware(): (_req: Request, _res: Response, next: NextFunction) => void;
//# sourceMappingURL=express.d.ts.map