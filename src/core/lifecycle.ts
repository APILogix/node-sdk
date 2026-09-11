/**
 * SDK Lifecycle — enterprise-grade graceful shutdown and reinit.
 *
 * Design principles:
 * - Bounded shutdown with deterministic timeout via Promise.race.
 * - Single-flight shutdown: concurrent calls share the same promise.
 * - Reverse-order teardown (LIFO): subsystems started last are torn down first.
 * - Idempotent reinit: every singleton, timer, and process listener is fully
 *   reset before the next init() can begin.
 * - No event leakage: shutdown rejects new events; pending pipelines drain
 *   to completion before disposal.
 * - No silent failures: per-step errors are captured, logged, and aggregated
 *   into the shutdown result for observability.
 *
 * Reinit guarantees (the contract for warm-start / hot-reload / serverless):
 *   1. ConfigManager singleton is destroyed; refresh + retry timers cleared.
 *   2. Process signal handlers (SIGTERM/SIGINT) are fully removed.
 *   3. Auto-instrumentation guard symbol is cleared.
 *   4. Global error handlers (uncaughtException/unhandledRejection) detached.
 *   5. Console.error wrapper unwrapped, Error.stackTraceLimit restored.
 *   6. All subsystem singletons (Logging, Profiling, Cron, Session,
 *      FeatureController, KillswitchEngine, SamplingEngine, LimitsEngine,
 *      SecurityScrubber, TransportRouter, Tracer) are reset.
 *   7. Memory pressure monitor stopped, circuit breaker / rate limiter reset.
 *   8. Persistent storage write chain drained, file handle released.
 */

import { eventQueue } from '../transport/queue.js'
import { TransportRouter } from '../transport/transport-router.js'
import { client } from './client.js'
import { getLogger } from '../utils/logger.js'
import { teardownPlugins } from '../plugins/index.js'
import { shutdownTracer, flushTracer } from '../tracing/tracer.js'
import { resetSessionManager } from '../session/session-manager.js'
import { resetGlobalErrorHandlers } from '../instrumentation/global-errors.js'
import { errorDeduplicator } from '../processors/deduplicator.js'
import { persistentStorage } from '../storage/persistent-storage.js'
import { metricsRegistry } from '../metrics/registry.js'
import { otelMetrics } from '../metrics/otel-adapter.js'
import { drainPendingEventProcessing, resetEventPipeline } from './event-pipeline.js'
import { resetAutoInstrumentations } from '../instrumentation/auto-instrument.js'
import { ConfigManager } from './config-manager.js'
import { FeatureController } from './feature-controller.js'
import { KillswitchEngine } from './killswitch-engine.js'
import { EntitlementGate } from './entitlement-gate.js'
import { SamplingEngine } from './sampling-engine.js'
import { LimitsEngine } from './limits-engine.js'
import { SecurityScrubber } from '../processors/security-scrubber.js'
import { LoggingSubsystem } from '../subsystems/logging-subsystem.js'
import { ProfilingSubsystem } from '../subsystems/profiling-subsystem.js'
import { CronSubsystem } from '../subsystems/cron-subsystem.js'
import { tenantGovernor } from './tenant-isolation.js'
import { cardinalityGovernor } from '../utils/cardinality-governor.js'
import { adaptivePressure } from '../utils/adaptive-pressure.js'
import { SerializationPool } from '../transport/serialization-pool.js'
import { QuotaController } from './quota-controller.js'
import { costGovernor } from '../utils/cost-governor.js'
import { persistenceGovernor } from '../storage/persistence-governor.js'
import { resetFingerprintCache } from '../processors/fingerprint.js'

// ─── Module State ───────────────────────────────────────────────────────────

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000
const HOOK_TIMEOUT_MS = 5_000
const SUBSYSTEM_STEP_TIMEOUT_MS = 5_000

let signalHandlersRegistered = false
let sigTermHandler: (() => void) | null = null
let sigIntHandler: (() => void) | null = null

let shuttingDown = false
let shutdownPromise: Promise<ShutdownResult> | null = null
let shutdownCompletionPromise: Promise<void> | null = null

const beforeShutdownHooks: Array<() => Promise<void>> = []

// ─── Public Types ───────────────────────────────────────────────────────────

export interface ShutdownStepError {
  readonly step: string
  readonly error: unknown
}

export interface ShutdownResult {
  readonly completed: boolean
  readonly timedOut: boolean
  readonly durationMs: number
  readonly remainingEvents: number
  readonly deadLetterCount: number
  readonly stepErrors: readonly ShutdownStepError[]
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check if the SDK is currently shutting down.
 * Used by capture paths and the queue to reject new events early.
 */
export function isSDKShuttingDown(): boolean {
  return shuttingDown
}

/**
 * Register a hook to be called before shutdown begins.
 * Hooks run in registration order with a per-hook timeout.
 * Failed hooks are logged but do not abort shutdown.
 */
export function onBeforeShutdown(hook: () => Promise<void>): void {
  beforeShutdownHooks.push(hook)
}

/**
 * Graceful shutdown — flushes telemetry, tears down subsystems, and resets
 * all global state so a subsequent init() starts from a clean slate.
 *
 * Concurrent invocations share the same in-flight shutdown promise; the
 * second caller does not start a duplicate teardown.
 *
 * @param timeoutMs Maximum time to wait for flush/teardown. Defaults to
 *   the SDK's configured shutdownTimeoutMs (10s if unset).
 * @returns A ShutdownResult describing what happened. Never throws.
 */
export async function shutdown(timeoutMs?: number): Promise<ShutdownResult> {
  if (shutdownPromise) {
    getLogger().debug('Shutdown already in progress, joining existing call')
    return shutdownPromise
  }

  shuttingDown = true
  const promise = runShutdown(timeoutMs)
  shutdownPromise = promise
  return promise
}

/**
 * Wait until all teardown work has released SDK-owned resources. A timed-out
 * public shutdown can finish cleanup in the background; init() uses this
 * barrier to prevent a new runtime from racing the previous one.
 * @internal
 */
export async function waitForShutdownCompletion(): Promise<void> {
  const completion = shutdownCompletionPromise
  if (completion) await completion
}

/**
 * Force-flush pending telemetry without tearing down the SDK.
 * Safe to call concurrently with regular event capture.
 */
export async function flush(): Promise<void> {
  await drainPendingEventProcessing()
  const router = TransportRouter.getInstance()
  if (router) {
    await router.flushAll()
  }
  await persistentStorage.flush()
}

/**
 * Emergency flush for crash scenarios (uncaughtException, SIGKILL).
 *
 * Drains only the event pipeline and transport queue with a hard timeout.
 * Does NOT shut down subsystems or tear down plugins — the process is
 * assumed to be terminating imminently.
 *
 * Design:
 *   - Best-effort: swallows all errors so it never makes a crash worse.
 *   - Bounded: hard timeout prevents indefinite process hang.
 *   - Lightweight: no subsystem teardown, no singleton resets.
 *
 * @param timeoutMs Maximum time to wait for transport drain. Default: 2000ms.
 */
export async function crashFlush(timeoutMs = 2_000): Promise<void> {
  try {
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref()
    })

    const drainPromise = (async () => {
      try {
        await drainPendingEventProcessing()
      } catch {
        // Best-effort — pipeline drain failure must not block transport flush
      }
      const router = TransportRouter.getInstance()
      if (router) {
        await router.flushAll()
      }
    })()

    await Promise.race([drainPromise, timeoutPromise])

    if (timer) clearTimeout(timer)
  } catch {
    // Best-effort — swallow all errors during crash flush.
    // The process is about to terminate; throwing here would only
    // mask the original uncaught exception in the error output.
  }
}

/**
 * Register SIGTERM/SIGINT handlers for automatic graceful shutdown.
 * Idempotent: a second call without an intervening reset is a no-op.
 */
export function registerSignalHandlers(): void {
  if (signalHandlersRegistered) return

  const logger = getLogger()

  const handleSignal = (signal: NodeJS.Signals) => {
    logger.info(`Received ${signal} — initiating graceful shutdown`)
    shutdown().catch(err => {
      logger.error('Shutdown failed after signal', { signal, error: err })
    })
  }

  sigTermHandler = () => handleSignal('SIGTERM')
  sigIntHandler = () => handleSignal('SIGINT')

  // Use process.on (not once) so we control removal explicitly via reset.
  // This prevents stacking handlers across reinit cycles.
  process.on('SIGTERM', sigTermHandler)
  process.on('SIGINT', sigIntHandler)

  signalHandlersRegistered = true
}

/**
 * Remove process signal handlers and reset module state.
 * Called automatically during shutdown; safe to call standalone.
 * @internal
 */
export function resetSignalHandlers(): void {
  if (sigTermHandler) {
    process.removeListener('SIGTERM', sigTermHandler)
    sigTermHandler = null
  }
  if (sigIntHandler) {
    process.removeListener('SIGINT', sigIntHandler)
    sigIntHandler = null
  }
  signalHandlersRegistered = false
}

// ─── Internal: Shutdown Orchestration ───────────────────────────────────────

async function runShutdown(timeoutMs?: number): Promise<ShutdownResult> {
  const logger = getLogger()
  const startedAt = Date.now()
  const timeout = resolveTimeout(timeoutMs)
  const stepErrors: ShutdownStepError[] = []

  logger.info('Telemetry shutdown started', {
    queuedEventCount: eventQueue.size(),
    timeoutMs: timeout,
  })

  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeout)
    timer.unref?.()
  })

  // Cleanup owns SDK resources until it settles. The public deadline may win
  // the race, but no second cleanup or re-init can begin while this promise is
  // active (init waits through waitForShutdownCompletion()).
  const completion = (async () => {
    try {
      await runOrchestratedShutdown(stepErrors)
    } catch (err) {
      stepErrors.push({ step: 'orchestrator', error: err })
    }
    await runUnconditionalCleanup(stepErrors)
  })()
  shutdownCompletionPromise = completion
  void completion.finally(() => {
    if (shutdownCompletionPromise === completion) {
      shutdownCompletionPromise = null
      shutdownPromise = null
      shuttingDown = false
    }
  }).catch(() => undefined)

  try {
    const outcome = await Promise.race([
      completion.then(() => 'done' as const),
      timeoutPromise,
    ])
    timedOut = outcome === 'timeout'
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (timedOut) {
    logger.warn('Shutdown deadline reached — cleanup continues under exclusive ownership', {
      remainingEvents: eventQueue.size(),
      durationMs: Date.now() - startedAt,
    })
  }

  const result: ShutdownResult = {
    completed: !timedOut && stepErrors.length === 0,
    timedOut,
    durationMs: Date.now() - startedAt,
    remainingEvents: eventQueue.size(),
    deadLetterCount: eventQueue.getDeadLetterCount(),
    stepErrors: Object.freeze([...stepErrors]),
  }

  logger.info('Telemetry shutdown completed', {
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    deadLetterCount: result.deadLetterCount,
    stepErrorCount: result.stepErrors.length,
  })

  return result
}

/**
 * Orchestrated shutdown — best-effort flush of every subsystem in reverse
 * dependency order. Each step is bounded; failures are recorded but do not
 * short-circuit the sequence.
 */
async function runOrchestratedShutdown(stepErrors: ShutdownStepError[]): Promise<void> {
  // 1. Run user/subsystem beforeShutdown hooks (snapshot first to avoid
  //    races with concurrent registrations during shutdown).
  const hooks = [...beforeShutdownHooks]
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i]
    if (!hook) continue
    await runStep(`beforeShutdown[${i}]`, () =>
      withTimeout(hook(), HOOK_TIMEOUT_MS, 'beforeShutdown hook timed out'),
      stepErrors
    )
  }

  // 2. Stop accepting new events at the queue boundary.
  eventQueue.setShuttingDown(true)

  // 3. Flush registry-backed metrics before feature teardown shuts down the
  //    meter provider. Mark these as internal so shutdown admission accepts
  //    the final aggregates; the marker is stripped before transport.
  await runStep('metrics.pre-teardown-flush', () =>
    withTimeout(metricsRegistry.flush(true), SUBSYSTEM_STEP_TIMEOUT_MS, 'metrics pre-teardown flush timed out'),
    stepErrors
  )

  // 4. Tear down active feature subsystems via the FeatureController so each
  //    subsystem gets its own teardown callback before raw resets.
  const featureController = FeatureController.getInstance()
  if (featureController) {
    await runStep('feature-controller.teardownAll', () =>
      withTimeout(featureController.teardownAll(), SUBSYSTEM_STEP_TIMEOUT_MS, 'teardownAll timed out'),
      stepErrors
    )
  }

  // 4. Force-flush OTel tracer so finished spans land in transport before
  //    the transport itself shuts down.
  await runStep('tracer.flush', () =>
    withTimeout(flushTracer(), SUBSYSTEM_STEP_TIMEOUT_MS, 'tracer flush timed out'),
    stepErrors
  )

  // 5. Drain in-flight event pipeline work (setImmediate-deferred async work).
  await runStep('event-pipeline.drain', () =>
    withTimeout(drainPendingEventProcessing(), SUBSYSTEM_STEP_TIMEOUT_MS, 'event pipeline drain timed out'),
    stepErrors
  )

  // 6. Flush metrics (snapshot + export) and stop the metric reader.
  await runStep('metrics.flush', async () => {
    // metricsRegistry.flush() now returns a Promise — await it so any
    // metrics still inside the OTel reader complete before we shutdown
    // the meter provider. Previously the call was fire-and-forget which
    // meant graceful shutdown could lose the last batch.
    await metricsRegistry.flush()
    await withTimeout(otelMetrics.shutdown(), SUBSYSTEM_STEP_TIMEOUT_MS, 'metrics shutdown timed out')
    metricsRegistry.stop()
  }, stepErrors)

  // 7. Flush transport queues — must run after pipeline drain so all
  //    deferred events have reached the transport router.
  await runStep('transport.flush', () =>
    withTimeout(flush(), SUBSYSTEM_STEP_TIMEOUT_MS, 'transport flush timed out'),
    stepErrors
  )

  // 8. Tear down user-registered plugins after their telemetry has flushed.
  await runStep('plugins.teardown', () =>
    withTimeout(teardownPlugins(), SUBSYSTEM_STEP_TIMEOUT_MS, 'plugin teardown timed out'),
    stepErrors
  )

  // 9. Shut down the tracer provider (releases context manager + processors).
  await runStep('tracer.shutdown', () =>
    withTimeout(shutdownTracer(), SUBSYSTEM_STEP_TIMEOUT_MS, 'tracer shutdown timed out'),
    stepErrors
  )

  // 10. Reset reactive subsystems (LIFO order vs. init).
  await runStep('cron.reset', () => Promise.resolve(CronSubsystem.reset()), stepErrors)
  await runStep('profiling.reset', () => Promise.resolve(ProfilingSubsystem.reset()), stepErrors)
  await runStep('logging.reset', () => Promise.resolve(LoggingSubsystem.reset()), stepErrors)
  await runStep('session.reset', () => Promise.resolve(resetSessionManager()), stepErrors)

  // 11. Reset global error handlers (process listeners + console.error wrap).
  await runStep('global-errors.reset', () => Promise.resolve(resetGlobalErrorHandlers()), stepErrors)

  // 12. Stop the deduplicator cleanup timer and clear its state.
  await runStep('deduplicator.stop', () => {
    errorDeduplicator.stop()
    errorDeduplicator.reset()
    return Promise.resolve()
  }, stepErrors)

  // 13. Drain residual events to disk before storage closes.
  //
  // Two queues hold events at this point:
  //   - The legacy in-memory `eventQueue` (pre-init buffer + legacy batcher).
  //   - The TransportRouter's per-route queues that the BatchManager flush
  //     could not deliver in step 7 (network down, retry budget exhausted,
  //     etc.). These are undelivered events that would be lost on process
  //     exit — persist them so the next init replays them.
  //
  // Order matters: drain BatchManager queues first (they hold the largest
  // backlog under outage scenarios), then the legacy queue.
  await runStep('persistent-storage.drain', async () => {
    const router = TransportRouter.getInstance()
    if (router) {
      // Quiesce active sends and retry timers before taking the residual
      // snapshot; queue-only draining can miss batches currently in fetch().
      const residual = await router.shutdown()
      if (residual.length > 0) {
        getLogger().warn('Persisting undelivered events from transport queues for replay on next start', {
          count: residual.length,
        })
        // SDKEvent and Event are interchangeable in this context — every
        // event flowing through transport already has eventId/timestamp.
        persistentStorage.persistBatch(residual as unknown as readonly import('../types/event.js').Event[])
      }
    }

    const legacyRemaining = eventQueue.drainAll()
    for (const event of legacyRemaining) {
      persistentStorage.persist(event)
    }
    await persistentStorage.flush()
  }, stepErrors)

  // 14. Shut down persistent storage (drains write chain, marks uninitialized).
  await runStep('persistent-storage.shutdown', () =>
    withTimeout(persistentStorage.shutdown(), SUBSYSTEM_STEP_TIMEOUT_MS, 'persistent storage shutdown timed out'),
    stepErrors
  )
}

/**
 * Unconditional cleanup — runs even if the orchestrated shutdown timed out
 * or threw. This is the line of defence that guarantees clean reinit:
 * every singleton is destroyed and every global hook is removed here.
 */
async function runUnconditionalCleanup(stepErrors: ShutdownStepError[]): Promise<void> {
  // Transport shutdown must complete before we null its singleton.
  await runStep('transport-router.shutdown', async () => {
    const router = TransportRouter.getInstance()
    if (router) {
      await withTimeout(router.shutdown(), SUBSYSTEM_STEP_TIMEOUT_MS, 'transport router shutdown timed out')
    }
  }, stepErrors)

  // Hard-reset every singleton so the next init() rebuilds from scratch.
  // Each call is wrapped to ensure a single failing reset never blocks the others.
  runSync('event-queue.clear', () => eventQueue.clear(), stepErrors)
  runSync('event-queue.shutdown-flag', () => eventQueue.setShuttingDown(false), stepErrors)
  runSync('event-pipeline.reset', () => resetEventPipeline(), stepErrors)
  runSync('client.clear', () => client.clear(), stepErrors)
  runSync('config-manager.reset', () => ConfigManager.reset(), stepErrors)
  runSync('feature-controller.reset', () => FeatureController.reset(), stepErrors)
  runSync('killswitch-engine.reset', () => KillswitchEngine.reset(), stepErrors)
  runSync('entitlement-gate.reset', () => EntitlementGate.reset(), stepErrors)
  runSync('sampling-engine.reset', () => SamplingEngine.reset(), stepErrors)
  runSync('limits-engine.reset', () => LimitsEngine.reset(), stepErrors)
  runSync('security-scrubber.reset', () => SecurityScrubber.reset(), stepErrors)
  runSync('global-errors.reset', () => resetGlobalErrorHandlers(), stepErrors)
  runSync('logging-subsystem.reset', () => LoggingSubsystem.reset(), stepErrors)
  runSync('profiling-subsystem.reset', () => ProfilingSubsystem.reset(), stepErrors)
  runSync('cron-subsystem.reset', () => CronSubsystem.reset(), stepErrors)
  runSync('session.reset', () => resetSessionManager(), stepErrors)
  runSync('signal-handlers.reset', () => resetSignalHandlers(), stepErrors)
  runSync('auto-instrumentations.reset', () => resetAutoInstrumentations(), stepErrors)
  // tenantGovernor is a module-level singleton (see tenant-isolation.ts).
  // Without an explicit reset here, a long-running process that re-inits
  // the SDK accumulates per-tenant rate-limit state across init cycles.
  runSync('tenant-governor.reset', () => tenantGovernor.reset(), stepErrors)
  runSync('cardinality-governor.shutdown', () => { cardinalityGovernor.shutdown(); cardinalityGovernor.reset() }, stepErrors)
  // adaptivePressure is started in init.ts (after metricsRegistry.start()).
  // Stop its timers/observers so a reinit cycle doesn't stack pollers.
  runSync('adaptive-pressure.stop', () => adaptivePressure.stop(), stepErrors)

  runSync('quota-controller.reset', () => QuotaController.reset(), stepErrors)
  runSync('cost-governor.reset', () => costGovernor.reset(), stepErrors)
  runSync('persistence-governor.reset', () => persistenceGovernor.reset(), stepErrors)
  runSync('fingerprint-cache.reset', () => resetFingerprintCache(), stepErrors)
  // Terminate serialization worker threads — awaited so they can't outlive
  // the SDK and hold the host process open across shutdown/reinit cycles.
  await runStep('serialization-pool.reset', async () => {
    await withTimeout(SerializationPool.reset(), SUBSYSTEM_STEP_TIMEOUT_MS, 'serialization pool reset timed out')
  }, stepErrors)

  // Clear lifecycle-local state last so beforeShutdown hooks added during
  // teardown have already executed before we drop the references.
  beforeShutdownHooks.length = 0
}

// ─── Internal: Step Execution ───────────────────────────────────────────────

async function runStep(
  step: string,
  fn: () => Promise<void> | void,
  errors: ShutdownStepError[]
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    getLogger().warn(`Shutdown step failed: ${step}`, { error })
    errors.push({ step, error })
  }
}

function runSync(step: string, fn: () => void, errors: ShutdownStepError[]): void {
  try {
    fn()
  } catch (error) {
    getLogger().warn(`Shutdown step failed: ${step}`, { error })
    errors.push({ step, error })
  }
}

async function withTimeout<T>(
  promise: Promise<T> | T,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resolveTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === 'number' && timeoutMs > 0) return timeoutMs

  // Avoid throwing if config isn't available (e.g., shutdown before init).
  try {
    const configured = client.options?.shutdownTimeoutMs
    if (typeof configured === 'number' && configured > 0) return configured
  } catch {
    /* client not initialized */
  }

  return DEFAULT_SHUTDOWN_TIMEOUT_MS
}
