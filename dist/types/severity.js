/**
 * Event severity levels — matches Sentry severity taxonomy.
 * Ordered from least to most severe for comparison operations.
 */
export const Severity = {
    Debug: 'debug',
    Info: 'info',
    Warning: 'warning',
    Error: 'error',
    Fatal: 'fatal',
};
const SEVERITY_ORDER = [
    Severity.Debug,
    Severity.Info,
    Severity.Warning,
    Severity.Error,
    Severity.Fatal,
];
const SEVERITY_WEIGHT = new Map(SEVERITY_ORDER.map((level, index) => [level, index]));
/**
 * Parses a string into a SeverityLevel.
 * Returns the fallback if the string doesn't match any known severity.
 */
export function severityFromString(value, fallback = Severity.Info) {
    if (!value)
        return fallback;
    const normalized = value.trim().toLowerCase();
    // Handle common aliases
    switch (normalized) {
        case 'debug':
        case 'trace':
            return Severity.Debug;
        case 'info':
        case 'log':
        case 'information':
            return Severity.Info;
        case 'warn':
        case 'warning':
            return Severity.Warning;
        case 'error':
        case 'err':
        case 'exception':
            return Severity.Error;
        case 'fatal':
        case 'critical':
        case 'panic':
            return Severity.Fatal;
        default:
            return fallback;
    }
}
/**
 * Returns true if `a` is more severe than or equal to `b`.
 */
export function severityGte(a, b) {
    return (SEVERITY_WEIGHT.get(a) ?? 0) >= (SEVERITY_WEIGHT.get(b) ?? 0);
}
/**
 * Returns true if the given severity meets the minimum threshold.
 */
export function severityMeetsThreshold(severity, threshold) {
    return severityGte(severity, threshold);
}
//# sourceMappingURL=severity.js.map