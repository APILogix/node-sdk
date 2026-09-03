export const SDK_CONSOLE_BYPASS = Symbol.for('pulse-sdk.console-bypass')

export function isSdkConsoleBypass(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<symbol, unknown>)[SDK_CONSOLE_BYPASS])
}

export function sdkConsoleLog(message: string, details: Readonly<Record<string, unknown>>): void {
  const safeDetails = { ...details }
  Object.defineProperty(safeDetails, SDK_CONSOLE_BYPASS, {
    value: true,
    enumerable: false,
  })
  console.log(message, safeDetails)
}
