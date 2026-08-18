export function sdkConsoleDebug(label: string, details: Readonly<Record<string, unknown>>): void {
  if (process.env['PULSE_SDK_CONSOLE_DEBUG'] !== 'true' && process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true') return
  console.log(`[Pulse SDK] ${label}`, details)
}
