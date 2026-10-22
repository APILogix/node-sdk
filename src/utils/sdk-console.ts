export const SDK_CONSOLE_BYPASS = Symbol.for('lynktrace.console-bypass')
export const SDK_CONSOLE_BYPASS_LEGACY = Symbol.for('pulse-sdk.console-bypass')

export function isSdkConsoleBypass(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ((value as Record<symbol, unknown>)[SDK_CONSOLE_BYPASS] || (value as Record<symbol, unknown>)[SDK_CONSOLE_BYPASS_LEGACY])
  )
}

export function sdkConsoleLog(message: string, details: Readonly<Record<string, unknown>>): void {
  // Transport diagnostics are intentionally opt-in. This function is called
  // from hot enqueue/send paths; unconditional console I/O would add
  // synchronous application-path overhead in production.
  if (
    process.env['LYNKTRACE_SDK_CONSOLE_DEBUG'] !== 'true' &&
    process.env['PULSE_SDK_CONSOLE_DEBUG'] !== 'true' &&
    process.env['LYNKTRACE_TRANSPORT_CONSOLE'] !== 'true' &&
    process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true'
  ) return

  const safeDetails = { ...details }
  Object.defineProperty(safeDetails, SDK_CONSOLE_BYPASS, {
    value: true,
    enumerable: false,
  })
  Object.defineProperty(safeDetails, SDK_CONSOLE_BYPASS_LEGACY, {
    value: true,
    enumerable: false,
  })
  console.log(message, safeDetails)
}
