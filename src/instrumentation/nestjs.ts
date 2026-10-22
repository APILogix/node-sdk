/**
 * NestJS Core Instrumentation — auto-instrumentation for @nestjs/core.
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js'

const NESTJS_GUARD = Symbol.for('pulse-sdk.patch.nestjs')

export function createNestJSInstrumentation(
  enabled: boolean,
): { enable: () => void; disable: () => void; teardown: () => void } | null {
  if (!enabled) return null

  const nest = resolveModuleSafe('@nestjs/core')
  if (!nest) return null

  let active = true

  return {
    enable: () => { active = true },
    disable: () => { active = false },
    teardown: () => { active = false },
  }
}
