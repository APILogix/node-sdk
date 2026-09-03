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
export function createBullMQInstrumentation(enabled, mergedOptions, captureConfig) {
    if (!enabled) {
        return null;
    }
    const captureBody = captureConfig?.body ?? false;
    const instrumentationOptions = {
        enabled: true,
        captureJobData: mergedOptions?.captureJobData ?? captureBody,
        captureWorkerEvents: mergedOptions?.captureWorkerEvents ?? true,
        captureQueueEvents: mergedOptions?.captureQueueEvents ?? false,
        maxJobDataSize: mergedOptions?.maxJobDataSize ?? 1024,
    };
    return new OTelBullMQInstrumentation(instrumentationOptions);
}
export { OTelBullMQInstrumentation };
export default createBullMQInstrumentation;
