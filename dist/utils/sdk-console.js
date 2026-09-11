export const SDK_CONSOLE_BYPASS = Symbol.for('pulse-sdk.console-bypass');
export function isSdkConsoleBypass(value) {
    return Boolean(value && typeof value === 'object' && value[SDK_CONSOLE_BYPASS]);
}
export function sdkConsoleLog(message, details) {
    const safeDetails = { ...details };
    Object.defineProperty(safeDetails, SDK_CONSOLE_BYPASS, {
        value: true,
        enumerable: false,
    });
    console.log(message, safeDetails);
}
