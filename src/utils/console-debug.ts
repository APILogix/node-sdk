export function sdkConsoleDebug(label: string, details: Readonly<Record<string, unknown>>): void {
  if (process.env['PULSE_SDK_CONSOLE_DEBUG'] !== 'true' && process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true') return
  console.log(`[Telemetry] ${label}`, publicDebugDetails(details))
}

function publicDebugDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const eventCount = numberValue(details['eventCount'])
  const payloadBytes = numberValue(details['payloadBytes'])
  const statusCode = numberValue(details['statusCode'])
  const latencyMs = numberValue(details['latencyMs'])
  const route = stringValue(details['route'])
  const eventType = stringValue(details['eventType'])
  const ok = typeof details['ok'] === 'boolean' ? details['ok'] : undefined

  return {
    ...(route ? { route } : {}),
    ...(eventType ? { eventType } : {}),
    ...(eventCount !== undefined ? { eventCount } : {}),
    ...(payloadBytes !== undefined ? { payloadBytes } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ok !== undefined ? { ok } : {}),
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
