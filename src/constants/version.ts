/**
 * Single source of truth for SDK name and version.
 *
 * Centralizes version and name information so all telemetry, metadata,
 * and span attributes reference the same value. Update this file on
 * every release; `package.json` should be kept in sync.
 */

/** SDK package name used in telemetry, tracers, and exporters. */
export const SDK_NAME = '@vikasbaplawat1/pulse-sdk'

/** SDK semantic version — corresponds to p.increments in `package.json`. */
export const SDK_VERSION = '2.0.0'
