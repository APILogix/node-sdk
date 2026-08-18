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
} as const

export type SeverityLevel = (typeof Severity)[keyof typeof Severity]

const SEVERITY_ORDER: readonly SeverityLevel[] = [
  Severity.Debug,
  Severity.Info,
  Severity.Warning,
  Severity.Error,
  Severity.Fatal,
] as const

const SEVERITY_WEIGHT: ReadonlyMap<SeverityLevel, number> = new Map(
  SEVERITY_ORDER.map((level, index) => [level, index])
)

/**
 * Parses a string into a SeverityLevel.
 * Returns the fallback if the string doesn't match any known severity.
 */
export function severityFromString(
  value: unknown,
  fallback: SeverityLevel = Severity.Info
): SeverityLevel {
  if (!value || typeof value !== 'string') return fallback

  const normalized = value.trim().toLowerCase()

  // Handle common aliases
  switch (normalized) {
    case 'debug':
    case 'trace':
      return Severity.Debug
    case 'info':
    case 'log':
    case 'information':
      return Severity.Info
    case 'warn':
    case 'warning':
      return Severity.Warning
    case 'error':
    case 'err':
    case 'exception':
      return Severity.Error
    case 'fatal':
    case 'critical':
    case 'panic':
      return Severity.Fatal
    default:
      return fallback
  }
}

/**
 * Returns true if `a` is more severe than or equal to `b`.
 */
export function severityGte(a: SeverityLevel, b: SeverityLevel): boolean {
  return (SEVERITY_WEIGHT.get(a) ?? 0) >= (SEVERITY_WEIGHT.get(b) ?? 0)
}

/**
 * Returns true if the given severity meets the minimum threshold.
 */
export function severityMeetsThreshold(
  severity: SeverityLevel,
  threshold: SeverityLevel
): boolean {
  return severityGte(severity, threshold)
}
