/**
 * Event severity levels — matches Sentry severity taxonomy.
 * Ordered from least to most severe for comparison operations.
 */
export declare const Severity: {
    readonly Debug: 'debug';
    readonly Info: 'info';
    readonly Warning: 'warning';
    readonly Error: 'error';
    readonly Fatal: 'fatal';
};
export type SeverityLevel = (typeof Severity)[keyof typeof Severity];
/**
 * Parses a string into a SeverityLevel.
 * Returns the fallback if the string doesn't match any known severity.
 */
export declare function severityFromString(value: unknown, fallback?: SeverityLevel): SeverityLevel;
/**
 * Returns true if `a` is more severe than or equal to `b`.
 */
export declare function isSeverityGte(a: SeverityLevel, b: SeverityLevel): boolean;
/**
 * Returns true if the given severity meets the minimum threshold.
 */
export declare function doesSeverityMeetThreshold(severity: SeverityLevel, threshold: SeverityLevel): boolean;
