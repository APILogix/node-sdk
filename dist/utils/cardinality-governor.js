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
import { getLogger } from './logger.js';
// ─── Default Blocked Attributes ─────────────────────────────────────────────
const DEFAULT_BLOCKED_ATTRIBUTES = [
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
];
// ─── Route Normalization Patterns ───────────────────────────────────────────
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_SEGMENT = /^[0-9]+$/;
const HEX_LONG = /^[0-9a-f]{9,}$/i;
const MONGO_ID = /^[0-9a-f]{24}$/i;
// ─── Implementation ─────────────────────────────────────────────────────────
export class CardinalityGovernor {
    maxDimensionsPerMetric;
    maxSeriesPerMetric;
    maxTotalSeries;
    blockedAttributes;
    enableRouteNormalization;
    // Track unique series per instrument: Map<instrumentName, Set<serializedLabels>>
    seriesTracker = new Map();
    totalSeries = 0;
    blockedAttributeCount = 0;
    droppedSeriesCount = 0;
    constructor(options = {}) {
        this.maxDimensionsPerMetric = options.maxDimensionsPerMetric ?? 10;
        this.maxSeriesPerMetric = options.maxSeriesPerMetric ?? 1000;
        this.maxTotalSeries = options.maxTotalSeries ?? 5000;
        this.blockedAttributes = new Set([
            ...DEFAULT_BLOCKED_ATTRIBUTES,
            ...(options.blockedAttributes ?? []),
        ]);
        this.enableRouteNormalization = options.enableRouteNormalization ?? true;
    }
    /**
     * Sanitize metric attributes — removes blocked keys, normalizes routes,
     * enforces dimension limits.
     *
     * Returns a cleaned copy of the attributes. Never mutates the input.
     */
    sanitizeAttributes(metricName, attributes) {
        const result = {};
        let dimensionCount = 0;
        for (const [key, value] of Object.entries(attributes)) {
            // Block known high-cardinality attributes
            if (this.blockedAttributes.has(key)) {
                this.blockedAttributeCount++;
                continue;
            }
            // Enforce dimension limit per metric
            if (dimensionCount >= this.maxDimensionsPerMetric) {
                getLogger().debug('Cardinality governor: dimension limit reached', {
                    metric: metricName,
                    droppedKey: key,
                    maxDimensions: this.maxDimensionsPerMetric,
                });
                break;
            }
            let sanitizedValue = value;
            // Route normalization for known route attributes
            if (this.enableRouteNormalization && isRouteAttribute(key)) {
                sanitizedValue = this.normalizeRoute(value);
            }
            // Truncate long values
            if (sanitizedValue.length > 256) {
                sanitizedValue = sanitizedValue.slice(0, 256);
            }
            result[key] = sanitizedValue;
            dimensionCount++;
        }
        return result;
    }
    /**
     * Check if recording a new series for this metric is allowed.
     * Returns false if cardinality limits would be exceeded.
     */
    canRecordSeries(metricName, attributeKey) {
        // Check total series limit
        if (this.totalSeries >= this.maxTotalSeries) {
            this.droppedSeriesCount++;
            return false;
        }
        // Check per-instrument limit
        let instrumentSeries = this.seriesTracker.get(metricName);
        if (!instrumentSeries) {
            instrumentSeries = new Set();
            this.seriesTracker.set(metricName, instrumentSeries);
        }
        if (instrumentSeries.has(attributeKey)) {
            return true; // Already tracked — no new series
        }
        if (instrumentSeries.size >= this.maxSeriesPerMetric) {
            this.droppedSeriesCount++;
            getLogger().warn('Cardinality governor: series limit reached for metric', {
                metric: metricName,
                seriesCount: instrumentSeries.size,
                maxSeries: this.maxSeriesPerMetric,
            });
            return false;
        }
        instrumentSeries.add(attributeKey);
        this.totalSeries++;
        return true;
    }
    /**
     * Normalize a URL path to remove dynamic segments.
     *
     * Examples:
     *   /users/123 → /users/:id
     *   /api/v1/orders/abc-def-123 → /api/v1/orders/:id
     *   /items?page=2&sort=name → /items
     */
    normalizeRoute(path) {
        // Strip query parameters
        const queryIndex = path.indexOf('?');
        let cleanPath = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
        // Strip fragment
        const hashIndex = cleanPath.indexOf('#');
        if (hashIndex >= 0) {
            cleanPath = cleanPath.slice(0, hashIndex);
        }
        // Replace UUIDs
        cleanPath = cleanPath.replace(UUID_PATTERN, ':id');
        // Normalize path segments
        const segments = cleanPath.split('/');
        const normalized = segments.map(segment => {
            if (!segment)
                return segment;
            // Already normalized
            if (segment === ':id')
                return segment;
            // Pure numeric → :id
            if (NUMERIC_SEGMENT.test(segment))
                return ':id';
            // MongoDB ObjectId (24-char hex)
            if (MONGO_ID.test(segment))
                return ':id';
            // Long hex strings (likely hashes/IDs)
            if (HEX_LONG.test(segment))
                return ':id';
            return segment;
        });
        return normalized.join('/');
    }
    getStats() {
        return {
            totalSeries: this.totalSeries,
            blockedAttributeCount: this.blockedAttributeCount,
            droppedSeriesCount: this.droppedSeriesCount,
            instrumentCount: this.seriesTracker.size,
        };
    }
    reset() {
        this.seriesTracker.clear();
        this.totalSeries = 0;
        this.blockedAttributeCount = 0;
        this.droppedSeriesCount = 0;
    }
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function isRouteAttribute(key) {
    const routeKeys = [
        'http.route',
        'http.target',
        'http.url',
        'url.path',
        'route',
        'path',
        'endpoint',
    ];
    return routeKeys.includes(key);
}
// ─── Singleton ──────────────────────────────────────────────────────────────
export const cardinalityGovernor = new CardinalityGovernor();
//# sourceMappingURL=cardinality-governor.js.map