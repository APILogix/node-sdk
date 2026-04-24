import { SDKError } from "../core/errors.js"

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

const SENSITIVE_KEY_PATTERN = /api[-_]?key|api[-_]?secret|authorization|cookie|token|password/i

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value)
  }

  if (Array.isArray(value)) {
    return value.map(redact)
  }

  if (!value || typeof value !== "object") {
    return value
  }

  if (value instanceof Error) {
    if (value instanceof SDKError) {
      return {
        name: value.name,
        message: value.message,
        code: value.code,
        context: redact(value.context),
        stack: value.stack,
      }
    }

    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  const redacted: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(nestedValue)
  }

  return redacted
}

function redactString(value: string) {
  return value
    .replace(/(api[-_]?key|token|authorization|password)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
}

function write(level: "debug" | "info" | "warn" | "error", message: string, context?: Record<string, unknown>) {
  const payload = context ? { message, ...redact(context) as Record<string, unknown> } : { message }
  console[level]("[SDK]", payload)
}

export const consoleLogger: Logger = {
  debug: (message, context) => write("debug", message, context),
  info: (message, context) => write("info", message, context),
  warn: (message, context) => write("warn", message, context),
  error: (message, context) => write("error", message, context),
}

let activeLogger: Logger = consoleLogger

export function setLogger(logger: Logger | undefined) {
  activeLogger = logger ?? consoleLogger
}

export function getLogger(): Logger {
  return activeLogger
}
