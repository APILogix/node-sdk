import { flush } from '../core/lifecycle.js'
import { captureException } from '../capture/captureException.js'
import { getLogger } from '../utils/logger.js'

export interface ServerlessHandlerOptions {
  /**
   * Maximum time in milliseconds to wait for telemetry to flush on handler completion or error.
   * Default: 1500ms.
   */
  readonly flushTimeoutMs?: number
  /**
   * Whether to capture unhandled exceptions thrown by the handler.
   * Default: true.
   */
  readonly captureErrors?: boolean
  /**
   * Whether to automatically set `context.callbackWaitsForEmptyEventLoop = false`
   * on AWS Lambda context objects.
   * Default: true.
   */
  readonly callbackWaitsForEmptyEventLoop?: boolean
}

export type ServerlessHandler<TEvent = unknown, TContext = unknown, TResult = unknown> = (
  event: TEvent,
  context: TContext,
  callback?: unknown,
) => Promise<TResult> | TResult

const DEFAULT_FLUSH_TIMEOUT_MS = 1500

/**
 * Wrap an AWS Lambda or serverless function handler to guarantee telemetry delivery.
 *
 * In serverless environments, background timers cannot flush events after the handler returns
 * because the hypervisor immediately freezes CPU execution.
 *
 * `wrapHandler`:
 * 1. Sets `context.callbackWaitsForEmptyEventLoop = false` (AWS Lambda best practice).
 * 2. Catches unhandled errors, captures them with `captureException`, flushes within deadline, and rethrows.
 * 3. On successful return, flushes pending traces, metrics, and logs synchronously before execution freeze.
 */
export function wrapHandler<TEvent = unknown, TContext = unknown, TResult = unknown>(
  handler: ServerlessHandler<TEvent, TContext, TResult>,
  options: ServerlessHandlerOptions = {},
): (event: TEvent, context: TContext, callback?: unknown) => Promise<TResult> {
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS
  const captureErrors = options.captureErrors ?? true
  const setCallbackWaits = options.callbackWaitsForEmptyEventLoop ?? true

  return async (event: TEvent, context: TContext, callback?: unknown): Promise<TResult> => {
    if (setCallbackWaits && context && typeof context === 'object') {
      try {
        ;(context as Record<string, unknown>).callbackWaitsForEmptyEventLoop = false
      } catch {
        // Ignore if context is frozen or property cannot be set
      }
    }

    try {
      const result = await Promise.resolve(handler(event, context, callback))
      await flushSafely(flushTimeoutMs)
      return result
    } catch (error) {
      if (captureErrors) {
        try {
          captureException(error instanceof Error ? error : new Error(String(error)))
        } catch (captureErr) {
          getLogger().debug('Failed to capture serverless handler exception', { error: captureErr })
        }
      }
      await flushSafely(flushTimeoutMs)
      throw error
    }
  }
}

async function flushSafely(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
    await Promise.race([flush(), timeoutPromise])
  } catch (error) {
    getLogger().debug('Serverless flush timed out or failed', { error })
  } finally {
    if (timer) clearTimeout(timer)
  }
}
