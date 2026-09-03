/**
 * Reports Types
 *
 * Types for analysis reports
 * Validates: Requirement 20.1
 */
/**
 * Report configuration
 */
export interface ReportConfig {
    format: 'json' | 'html' | 'markdown';
    includeCharts: boolean;
    includeDetails: boolean;
    outputPath: string;
}
/**
 * Report result
 */
export interface ReportResult {
    format: string;
    path: string;
    generated: Date;
    size: number;
    status: 'success' | 'error';
    error?: string;
}
/**
 * Report section
 */
export interface ReportSection {
    title: string;
    content: string;
    order: number;
}
/**
 * Report metadata
 */
export interface ReportMetadata {
    title: string;
    description: string;
    version: string;
    generatedAt: Date;
    analysisDuration: number;
}
