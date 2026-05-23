/**
 * BullMQ Instrumentation — OpenTelemetry auto-instrumentation
 * wrapped with Pulse SDK guards and remote config support.
 *
 * Features:
 * - Job spans with name, queue, attempts, and duration
 * - Worker lifecycle tracking
 * - Queue event monitoring
 * - Error tracking with job data
 * - Scheduled/future job support
 * - Flow parent/child tracking
 */
import { BullMQInstrumentation as OTelBullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq';
import type { TracingCaptureConfig } from '../types/config.js';
export interface BullMQInstrumentationOptions {
    enabled: boolean;
    captureJobData?: boolean;
    captureWorkerEvents?: boolean;
    captureQueueEvents?: boolean;
    maxJobDataSize?: number;
}
export declare function createBullMQInstrumentation(enabled: boolean, mergedOptions?: Partial<BullMQInstrumentationOptions>, captureConfig?: TracingCaptureConfig): OTelBullMQInstrumentation | null;
export interface BullMQSpanAttributes {
    'messaging.system': 'bullmq';
    'messaging.destination': string;
    'messaging.operation': 'process' | 'add' | 'remove' | 'retry';
    'messaging.bullmq.job.id'?: string;
    'messaging.bullmq.job.name': string;
    'messaging.bullmq.job.attempts': number;
    'messaging.bullmq.job.timestamp': number;
    'messaging.bullmq.queue.name': string;
}
export { OTelBullMQInstrumentation };
export default createBullMQInstrumentation;
//# sourceMappingURL=bullmq.d.ts.map