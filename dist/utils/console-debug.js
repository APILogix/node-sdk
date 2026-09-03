export function sdkConsoleDebug(label, details) {
    if (process.env['PULSE_SDK_CONSOLE_DEBUG'] !== 'true' && process.env['PULSE_TRANSPORT_CONSOLE'] !== 'true')
        return;
    console.log(`[Pulse] ${label}`, publicDebugDetails(details));
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
