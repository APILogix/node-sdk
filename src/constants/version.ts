/**
 * Single source of truth for SDK name and version.
 *
 * Centralizes version and name information so all telemetry, metadata,
 * and span attributes reference the same value. Update this file on
 * every release; `package.json` should be kept in sync.
 */

/** SDK package name used in telemetry, tracers, and exporters. */
export const SDK_NAME = '@pulse-apm/node'

/** SDK semantic version — corresponds to increments in `package.json`. */
export const SDK_VERSION = '8.1.2'
