/**
 * Auto Instrumentation — selective OpenTelemetry instrumentations
 * wrapped with Pulse SDK guards, driven by remote config.
 *
 * Reads from ConfigManager.getConfig().instrumentation to decide
 * which modules to patch. Never monkey-patches a module if its
 * remote config flag is false.
 *
 * Lifecycle guarantees:
 * - Idempotent registration via a global symbol guard (safe across multiple
 *   imports of the SDK in the same process — common in monorepos).
 * - Full reset on shutdown: the guard symbol is cleared AND every
 *   instrumentation that exposes a teardown is invoked. This ensures the
 *   next init() rebuilds instrumentation from scratch.
 *
 * Architecture:
 *   OTel Instrumentation → Pulse SpanProcessor → PipelineSpanExporter → EventPipeline
 */
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { BullMQInstrumentation } from 'opentelemetry-instrumentation-bullmq';
/**
 * Wait for any asynchronous instrumentation setup (such as Axios ESM loader)
 * to complete before application code executes.
 */
export declare function waitForPendingInstrumentations(): Promise<void>;
/**
 * Register all configured auto-instrumentations.
 * Idempotent: a second call without an intervening reset is a no-op.
 * Upgrades bootstrap hooks in-place without unregistering or losing loaded module monkey-patches.
 */
export declare function registerAutoInstrumentations(): void;
/**
 * Install safe module-load hooks as soon as the SDK package is imported.
 *
 * This closes the common ESM/CJS race where application code imports LynkTrace,
 * starts `createSDK()`, and imports DB clients while the one remote-config
 * request is still in flight. The early hooks use privacy-safe defaults and
 * a no-op/proxy tracer until `initTracer()` installs the real provider. Once
 * remote config arrives, `registerAutoInstrumentations()` upgrades the same
 * hooks in-place without unregistering or unwrapping modules.
 *
 * SEC-08 Guarantees:
 * - Every instrumentation factory is individually isolated in a safe try-catch.
 * - Missing or throwing optional dependencies never bubble up.
 * - The entire bootstrap routine is wrapped in a fail-open boundary so that
 *   importing `@lynktrace/node` can never crash host application startup.
 */
export declare function registerBootstrapAutoInstrumentations(): void;
/**
 * Fully reset auto-instrumentation state.
 *
 * Steps:
 *   1. Run registered teardown callbacks (e.g., axios unwrap).
 *   2. Call the OTel unregister handle to disable every instrumentation.
 *   3. Clear the global guard so the next register call rebuilds from scratch.
 *
 * Errors in any single teardown are logged but never thrown — reset must
 * always succeed so a failed instrumentation cannot block SDK reinit.
 */
export declare function resetAutoInstrumentations(): void;
export { GraphQLInstrumentation, MongoDBInstrumentation, RedisInstrumentation, PrismaInstrumentation, BullMQInstrumentation };
