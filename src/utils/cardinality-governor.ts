/**
 * Cardinality Governor — enterprise protection against metric dimension explosion.
 *
 * Prevents:
 * - userId/requestId/traceId as metric labels (unbounded cardinality)
 * - Dynamic route parameters in metric labels (/users/123 → /users/:id)
 * - Query parameter leakage into labels
 * - Metric series explosion (bounded per-instrument and total)
 * - Histogram dimension explosion
 *
 * Enterprise observability platforms (Datadog, New Relic) impose cardinality
 * limits server-side. We enforce them SDK-side to prevent ingestion rejection.
 */

import { getLogger } from './logger.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CardinalityGovernorOptions {
    /** Max attribute keys per metric instrument. Default: 10 */
    readonly maxDimensionsPerMetric?: number
    /** Max unique timeseries per instrument. Default: 1000 */
    readonly maxSeriesPerMetric?: number
    /** Max total timeseries across all instruments. Default: 5000 */
    readonly maxTotalSeries?: number
    /** Attribute names that are ALWAYS blocked as metric labels. */
    readonly blockedAttributes?: readonly string[]
    /** Enable automatic route path normalization. Default: true */
    readonly enableRouteNormalization?: boolean
}

export interface CardinalityStats {
    readonly totalSeries: number
    readonly blockedAttributeCount: number
    readonly droppedSeriesCount: number
    readonly instrumentCount: number
}

// ─── Default Blocked Attributes ─────────────────────────────────────────────

const DEFAULT_BLOCKED_ATTRIBUTES: readonly string[] = [
    'userId',
    'user_id',
    'user.id',
    'requestId',
    'request_id',
    'request.id',
    'traceId',
    'trace_id',
    'trace.id',
    'spanId',
    'span_id',
    'span.id',
    'sessionId',
    'session_id',
    'session.id',
    'correlationId',
    'correlation_id',
    'transactionId',
    'transaction_id',
    'ip',
    'ip_address',
    'email',
    'username',
]

// ─── Route Normalization Patterns ───────────────────────────────────────────

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const NUMERIC_SEGMENT = /^[0-9]+$/
const HEX_LONG = /^[0-9a-f]{9,}$/i
const MONGO_ID = /^[0-9a-f]{24}$/i

// ─── Implementation ─────────────────────────────────────────────────────────

export class CardinalityGovernor {
    private readonly maxDimensionsPerMetric: number
    private readonly maxSeriesPerMetric: number
    private readonly maxTotalSeries: number
    private readonly blockedAttributes: ReadonlySet<string>
    private readonly enableRouteNormalization: boolean

    // Track unique series per instrument: Map<instrumentName, Set<serializedLabels>>
    private seriesTracker = new Map<string, Set<string>>()
    private totalSeries = 0
    private blockedAttributeCount = 0
    private droppedSeriesCount = 0

    // Periodic eviction timer — resets tracked series every hour so that
    // the cardinality budget can recover after transient spikes. Without
    // this, once maxTotalSeries or maxSeriesPerMetric is hit, new metric
    // series are permanently dropped until the process restarts.
    private evictionTimer: ReturnType<typeof setInterval> | null = null
    private static readonly EVICTION_INTERVAL_MS = 3_600_000 // 1 hour

    constructor(options: CardinalityGovernorOptions = {}) {
        this.maxDimensionsPerMetric = options.maxDimensionsPerMetric ?? 10
        this.maxSeriesPerMetric = options.maxSeriesPerMetric ?? 1000
        this.maxTotalSeries = options.maxTotalSeries ?? 5000
        this.blockedAttributes = new Set([
            ...DEFAULT_BLOCKED_ATTRIBUTES,
            ...(options.blockedAttributes ?? []),
        ])
        this.enableRouteNormalization = options.enableRouteNormalization ?? true

        this.evictionTimer = setInterval(() => this.evictStaleSeries(), CardinalityGovernor.EVICTION_INTERVAL_MS)
        this.evictionTimer.unref()
    }

    /**
     * Sanitize metric attributes — removes blocked keys, normalizes routes,
     * enforces dimension limits.
     *
     * Returns a cleaned copy of the attributes. Never mutates the input.
     */
    sanitizeAttributes(metricName: string, attributes: Record<string, string>): Record<string, string> {
        const result: Record<string, string> = {}
        let dimensionCount = 0

        for (const [key, value] of Object.entries(attributes)) {
            // Block known high-cardinality attributes
            if (this.blockedAttributes.has(key)) {
                this.blockedAttributeCount++
                continue
            }

            // Enforce dimension limit per metric
            if (dimensionCount >= this.maxDimensionsPerMetric) {
                getLogger().debug('Cardinality governor: dimension limit reached', {
                    metric: metricName,
                    droppedKey: key,
                    maxDimensions: this.maxDimensionsPerMetric,
                })
                break
            }

            let sanitizedValue = typeof value === 'string' ? value : String(value ?? '')

            // Route normalization for known route attributes
            if (this.enableRouteNormalization && isRouteAttribute(key)) {
                sanitizedValue = this.normalizeRoute(sanitizedValue)
            }

            // Truncate long values
            if (sanitizedValue.length > 256) {
                sanitizedValue = sanitizedValue.slice(0, 256)
            }

            result[key] = sanitizedValue
            dimensionCount++
        }

        return result
    }

    /**
     * Check if recording a new series for this metric is allowed.
     * Returns false if cardinality limits would be exceeded.
     */
    canRecordSeries(metricName: string, attributeKey: string): boolean {
        // Check total series limit
        if (this.totalSeries >= this.maxTotalSeries) {
            this.droppedSeriesCount++
            return false
        }

        // Check per-instrument limit
        let instrumentSeries = this.seriesTracker.get(metricName)
        if (!instrumentSeries) {
            instrumentSeries = new Set<string>()
            this.seriesTracker.set(metricName, instrumentSeries)
        }

        if (instrumentSeries.has(attributeKey)) {
            return true // Already tracked — no new series
        }

        if (instrumentSeries.size >= this.maxSeriesPerMetric) {
            this.droppedSeriesCount++
            getLogger().warn('Cardinality governor: series limit reached for metric', {
                metric: metricName,
                seriesCount: instrumentSeries.size,
                maxSeries: this.maxSeriesPerMetric,
            })
            return false
        }

        instrumentSeries.add(attributeKey)
        this.totalSeries++
        return true
    }

    /**
     * Normalize a URL path to remove dynamic segments.
     *
     * Examples:
     *   /users/123 → /users/:id
     *   /api/v1/orders/abc-def-123 → /api/v1/orders/:id
     *   /items?page=2&sort=name → /items
     */
    normalizeRoute(path: string): string {
        if (typeof path !== 'string') path = String(path ?? '')
        // Strip query parameters
        const queryIndex = path.indexOf('?')
        let cleanPath = queryIndex >= 0 ? path.slice(0, queryIndex) : path

        // Strip fragment
        const hashIndex = cleanPath.indexOf('#')
        if (hashIndex >= 0) {
            cleanPath = cleanPath.slice(0, hashIndex)
        }

        // Replace UUIDs
        cleanPath = cleanPath.replace(UUID_PATTERN, ':id')

        // Normalize path segments
        const segments = cleanPath.split('/')
        const normalized = segments.map(segment => {
            if (!segment) return segment

            // Already normalized
            if (segment === ':id') return segment

            // Pure numeric → :id
            if (NUMERIC_SEGMENT.test(segment)) return ':id'

            // MongoDB ObjectId (24-char hex)
            if (MONGO_ID.test(segment)) return ':id'

            // Long hex strings (likely hashes/IDs)
            if (HEX_LONG.test(segment)) return ':id'

            return segment
        })

        return normalized.join('/')
    }

    getStats(): CardinalityStats {
        return {
            totalSeries: this.totalSeries,
            blockedAttributeCount: this.blockedAttributeCount,
            droppedSeriesCount: this.droppedSeriesCount,
            instrumentCount: this.seriesTracker.size,
        }
    }

    reset(): void {
        this.seriesTracker.clear()
        this.totalSeries = 0
        this.blockedAttributeCount = 0
        this.droppedSeriesCount = 0
    }

    /**
     * Stop the eviction timer. Call during SDK shutdown to prevent
     * the timer from holding the process alive.
     */
    shutdown(): void {
        if (this.evictionTimer) {
            clearInterval(this.evictionTimer)
            this.evictionTimer = null
        }
    }

    /**
     * Periodic eviction — clears all tracked series and resets the
     * totalSeries counter. This is intentionally a full reset rather
     * than a partial eviction: cardinality limits are a *rate* budget
     * ("max N unique series per window"), not a lifetime cap.
     *
     * Enterprise platforms (Datadog, New Relic) impose hourly custom-
     * metric limits in the same way.
     */
    private evictStaleSeries(): void {
        if (this.seriesTracker.size === 0) return
        const evictedInstruments = this.seriesTracker.size
        const evictedSeries = this.totalSeries
        this.seriesTracker = new Map()
        this.totalSeries = 0
        getLogger().debug('Cardinality governor: evicted stale series', {
            evictedInstruments,
            evictedSeries,
        })
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRouteAttribute(key: string): boolean {
    const routeKeys = [
        'http.route',
        'http.target',
        'http.url',
        'url.path',
        'route',
        'path',
        'endpoint',
    ]
    return routeKeys.includes(key)
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const cardinalityGovernor = new CardinalityGovernor()
