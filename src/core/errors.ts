export class SDKError extends Error {
  public readonly code: string
  public readonly context: Record<string, unknown>

  constructor(message: string, code: string, context: Record<string, unknown> = {}, cause?: unknown) {
    super(message, { cause })
    this.name = "SDKError"
    this.code = code
    this.context = context
  }
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === "string") return new Error(value)

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const msg = typeof record.message === 'string' && record.message
      ? record.message
      : (() => { try { return JSON.stringify(value) } catch { return String(value) } })()
    const err = new Error(msg)
    if (typeof record.name === 'string') err.name = record.name
    if (typeof record.stack === 'string') err.stack = record.stack
    if (typeof record.statusCode === 'number') (err as any).statusCode = record.statusCode
    if (typeof record.status === 'number') (err as any).status = record.status
    if (typeof record.code === 'string' || typeof record.code === 'number') (err as any).code = record.code
    return err
  }

  return new Error(String(value))
}

export function extractErrorCauseChain(error: unknown, maxDepth = 5): Array<{ name: string; message: string; stack?: string }> {
  const chain: Array<{ name: string; message: string; stack?: string }> = []
  let cur: any = error
  while (cur && cur.cause && chain.length < maxDepth) {
    cur = cur.cause
    chain.push({ name: cur.name ?? 'Error', message: cur.message ?? String(cur), stack: cur.stack })
  }
  return chain
}

