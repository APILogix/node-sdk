export function sanitizeHeaders(headers: Record<string, any>) {
  const sanitized = { ...headers }

  const sensitiveKeys = [
    "authorization",
    "cookie",
    "x-api-key",
  ]

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]"
    }
  }

  return sanitized
}