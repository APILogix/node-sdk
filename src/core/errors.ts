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

  try {
    return new Error(JSON.stringify(value))
  } catch {
    return new Error(String(value))
  }
}
