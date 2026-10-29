import { SDK_CONSOLE_BYPASS, SDK_CONSOLE_BYPASS_LEGACY } from './sdk-console.js';
export function sdkConsoleDebug(label, details) {
    if (process.env['LYNKTRACE_SDK_CONSOLE_DEBUG'] !== 'true' &&
        process.env['PULSE_SDK_CONSOLE_DEBUG'] !== 'true' &&
        process.env['LYNKTRACE_TRANSPORT_CONSOLE'] !== 'true' &&
        process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true')
        return;
    const safeDetails = publicDebugDetails(details);
    Object.defineProperty(safeDetails, SDK_CONSOLE_BYPASS, {
        value: true,
        enumerable: false,
    });
    Object.defineProperty(safeDetails, SDK_CONSOLE_BYPASS_LEGACY, {
        value: true,
        enumerable: false,
    });
    console.log(`[Telemetry] ${label}`, safeDetails);
}
function publicDebugDetails(details) {
    const eventCount = numberValue(details['eventCount']);
    const payloadBytes = numberValue(details['payloadBytes']);
    const statusCode = numberValue(details['statusCode']);
    const latencyMs = numberValue(details['latencyMs']);
    const route = stringValue(details['route']);
    const eventType = stringValue(details['eventType']);
    const ok = typeof details['ok'] === 'boolean' ? details['ok'] : undefined;
    return {
        ...(route ? { route } : {}),
        ...(eventType ? { eventType } : {}),
        ...(eventCount !== undefined ? { eventCount } : {}),
        ...(payloadBytes !== undefined ? { payloadBytes } : {}),
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(ok !== undefined ? { ok } : {}),
    };
}
function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function stringValue(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
