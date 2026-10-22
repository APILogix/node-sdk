/**
 * BullMQ Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with LynkTrace SDK guards and remote config support.
 *
 * Features:
 * - Job spans with name, queue, attempts, and duration
 * - Worker lifecycle tracking
 * - Queue event monitoring
 * - Error tracking with job data
 * - Scheduled/future job support
 * - Flow parent/child tracking
 */

import { BullMQInstrumentation as OTelBullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq'
import type { PrivacyCaptureConfig } from '../types/config.js'

export interface BullMQInstrumentationOptions {
  enabled: boolean
  captureJobData?: boolean
  captureWorkerEvents?: boolean
  captureQueueEvents?: boolean
  maxJobDataSize?: number
  emitCreateSpansForBulk?: boolean
  emitCreateSpansForFlow?: boolean
  requireParentSpanForPublish?: boolean
}

export function createBullMQInstrumentation(
  enabled: boolean,
  mergedOptions?: Partial<BullMQInstrumentationOptions>,
  captureConfig?: PrivacyCaptureConfig
): OTelBullMQInstrumentation | null {
  if (!enabled) {
    return null
  }

  const captureBody = captureConfig?.body ?? false

  const instrumentationOptions: Record<string, unknown> = {
    enabled: true,
    captureJobData: mergedOptions?.captureJobData ?? captureBody,
    captureWorkerEvents: mergedOptions?.captureWorkerEvents ?? true,
    captureQueueEvents: mergedOptions?.captureQueueEvents ?? false,
    maxJobDataSize: mergedOptions?.maxJobDataSize ?? 1024,
    ...(mergedOptions?.emitCreateSpansForBulk !== undefined ? { emitCreateSpansForBulk: mergedOptions.emitCreateSpansForBulk } : {}),
    ...(mergedOptions?.emitCreateSpansForFlow !== undefined ? { emitCreateSpansForFlow: mergedOptions.emitCreateSpansForFlow } : {}),
    ...(mergedOptions?.requireParentSpanForPublish !== undefined ? { requireParentSpanForPublish: mergedOptions.requireParentSpanForPublish } : {}),
  }

  return new OTelBullMQInstrumentation(instrumentationOptions as any)
}

export interface BullMQSpanAttributes {
  'messaging.system': 'bullmq'
  'messaging.destination': string
  'messaging.operation': 'process' | 'add' | 'remove' | 'retry'
  'messaging.bullmq.job.id'?: string
  'messaging.bullmq.job.name': string
  'messaging.bullmq.job.attempts': number
  'messaging.bullmq.job.timestamp': number
  'messaging.bullmq.queue.name': string
}

export { OTelBullMQInstrumentation }
export default createBullMQInstrumentation