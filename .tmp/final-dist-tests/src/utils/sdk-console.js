export const SDK_CONSOLE_BYPASS = Symbol.for('pulse-sdk.console-bypass');
export function isSdkConsoleBypass(value) {
    return Boolean(value && typeof value === 'object' && value[SDK_CONSOLE_BYPASS]);
}
export function sdkConsoleLog(message, details) {
    // Transport diagnostics are intentionally opt-in. This function is called
    // from hot enqueue/send paths; unconditional console I/O would add
    // synchronous application-path overhead in production.
    if (process.env['PULSE_SDK_CONSOLE_DEBUG'] !== 'true' && process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true')
        return;
    const safeDetails = { ...details };
    Object.defineProperty(safeDetails, SDK_CONSOLE_BYPASS, {
        value: true,
        enumerable: false,
    });
    console.log(message, safeDetails);
}
