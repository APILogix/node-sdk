import { flush } from '../core/lifecycle.js'
import { captureException } from '../capture/captureException.js'
import { createContextStore, withContext } from '../core/context.js'
import { generateId } from '../utils/uuid.js'
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
 * 2. Isolates execution in a fresh ContextStore to prevent cross-invocation context bleed.
 * 3. Handles both async/Promise handlers and callback-style handlers (handler.length >= 3).
 * 4. Catches unhandled errors, captures them with `captureException`, flushes within deadline, and rethrows.
 * 5. On successful return, flushes pending traces, metrics, and logs synchronously before execution freeze.
 */
export function wrapHandler<TEvent = unknown, TContext = unknown, TResult = unknown>(
  handler: ServerlessHandler<TEvent, TContext, TResult>,
  options: ServerlessHandlerOptions = {},
): (event: TEvent, context: TContext, callback?: unknown) => Promise<TResult> {
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS
  const captureErrors = options.captureErrors ?? true
  const setCallbackWaits = options.callbackWaitsForEmptyEventLoop ?? true

  return async (event: TEvent, context: TContext, callback?: unknown): Promise<TResult> => {
    let requestId = generateId()
    if (context && typeof context === 'object') {
      const ctxObj = context as Record<string, unknown>
      if (typeof ctxObj['awsRequestId'] === 'string' && ctxObj['awsRequestId']) {
        requestId = ctxObj['awsRequestId']
      }
      if (setCallbackWaits) {
        try {
          ctxObj.callbackWaitsForEmptyEventLoop = false
        } catch {}
      }
    }

    const store = createContextStore(requestId, 100, {
      tags: { runtime: 'serverless' },
    })

    return withContext(store, async () => {
      try {
        const result = await executeHandler(handler, event, context, callback)
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
    })
  }
}

function executeHandler<TEvent, TContext, TResult>(
  handler: ServerlessHandler<TEvent, TContext, TResult>,
  event: TEvent,
  context: TContext,
  callback?: unknown,
): Promise<TResult> {
  if (handler.length >= 3) {
    return new Promise<TResult>((resolve, reject) => {
      let settled = false
      const cb = (err: unknown, res?: TResult) => {
        if (settled) return
        settled = true
        if (typeof callback === 'function') {
          try { (callback as Function)(err, res) } catch {}
        }
        if (err) reject(err)
        else resolve(res as TResult)
      }
      try {
        const maybePromise = handler(event, context, cb)
        if (maybePromise && typeof (maybePromise as Promise<TResult>).then === 'function') {
          ;(maybePromise as Promise<TResult>).then(
            res => {
              if (!settled) {
                settled = true
                resolve(res)
              }
            },
            err => {
              if (!settled) {
                settled = true
                reject(err)
              }
            },
          )
        }
      } catch (syncErr) {
        if (!settled) {
          settled = true
          reject(syncErr)
        }
      }
    })
  }
  return Promise.resolve(handler(event, context, callback))
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
