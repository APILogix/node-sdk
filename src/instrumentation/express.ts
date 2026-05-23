/**
 * Compatibility shim.
 *
 * Express tracing is provided by OpenTelemetry ExpressInstrumentation.
 * The legacy middleware remains export-compatible but does not patch response
 * methods, create spans, or capture duplicate request telemetry.
 */

import type { Request, Response, NextFunction } from 'express'
import { getLogger } from '../utils/logger.js'

let warned = false

export function monitorMiddleware() {
  return function (_req: Request, _res: Response, next: NextFunction) {
    if (!warned) {
      warned = true
      getLogger().info('Express manual middleware is a no-op; OpenTelemetry owns Express tracing')
    }
    next()
  }
}
