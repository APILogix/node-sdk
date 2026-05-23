/**
 * Compatibility shim.
 *
 * Fastify tracing is provided by OpenTelemetry FastifyInstrumentation.
 * The legacy plugin remains export-compatible but does not create spans,
 * inject propagation headers, or capture duplicate request telemetry.
 */

import { getLogger } from '../utils/logger.js'

export interface PulseFastifyOptions {
  ignorePaths?: string[]
  captureHeaders?: boolean
  captureQuery?: boolean
  maxBreadcrumbs?: number
}

type FastifyInstance = {
  addHook?(name: string, handler: (...args: unknown[]) => void): void
}

export function fastifyPulsePlugin(
  _fastify: FastifyInstance,
  _opts: PulseFastifyOptions,
  done: (err?: Error) => void
): void {
  getLogger().info('Fastify manual plugin is a no-op; OpenTelemetry owns Fastify tracing')
  done()
}
