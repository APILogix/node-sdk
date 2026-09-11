import type { SeverityLevel } from './severity.js';
/**
 * A breadcrumb records an event that happened prior to an issue.
 * Breadcrumbs are attached to errors/exceptions to provide context.
 * Modeled after Sentry's breadcrumb specification.
 */
export interface Breadcrumb {
    /** ISO 8601 timestamp of when the breadcrumb was recorded. */
    readonly timestamp: string;
    /** Category for grouping (e.g. 'http', 'navigation', 'console', 'ui'). */
    readonly category: string;
    /** Human-readable message describing what happened. */
    readonly message?: string | undefined;
    /** Severity level of the breadcrumb. */
    readonly level: SeverityLevel;
    /** Breadcrumb type for UI rendering (e.g. 'default', 'http', 'navigation', 'error', 'query'). */
    readonly type: BreadcrumbType;
    /** Arbitrary structured data associated with this breadcrumb. */
    readonly data?: Readonly<Record<string, unknown>> | undefined;
}
export type BreadcrumbType = 'default' | 'http' | 'navigation' | 'error' | 'query' | 'ui' | 'user' | 'info' | 'debug';
/**
 * Hint passed to beforeBreadcrumb for enrichment/filtering.
 * Contains the original source event that produced the breadcrumb.
 */
export interface BreadcrumbHint {
    /** The original DOM/HTTP/DB event that triggered this breadcrumb. */
    readonly originalEvent?: unknown;
    /** Synthetic data supplied by the caller. */
    readonly data?: Readonly<Record<string, unknown>>;
}
/**
 * Input type for creating breadcrumbs — all fields optional except category.
 * The SDK fills in defaults for timestamp, level, type.
 */
export interface BreadcrumbInput {
    readonly category: string;
    readonly message?: string;
    readonly level?: SeverityLevel;
    readonly type?: BreadcrumbType;
    readonly data?: Readonly<Record<string, unknown>>;
}
