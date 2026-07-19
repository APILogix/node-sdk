/**
 * Analysis Types Module
 *
 * Core type definitions for the analysis module
 *
 * Validates: Requirement 20.1
 */
export * from './coordinator/types.js';
export * from './static/types.js';
export * from './runtime/types.js';
export * from './reports/types.js';
/**
 * Analysis configuration options
 */
export interface AnalysisConfig {
    /** Enable static analysis */
    staticAnalysis: boolean;
    /** Enable runtime analysis */
    runtimeAnalysis: boolean;
    /** Output format for reports */
    outputFormat: 'json' | 'html' | 'markdown';
    /** Target paths to analyze */
    targets: string[];
}
/**
 * Analysis result summary
 */
export interface AnalysisSummary {
    timestamp: Date;
    staticAnalysis?: StaticAnalysisResult;
    runtimeAnalysis?: RuntimeAnalysisResult;
    reports: ReportResult[];
}
/**
 * Static analysis result
 */
export interface StaticAnalysisResult {
    architectureScore: number;
    dependencies: DependencyInfo[];
    issues: AnalysisIssue[];
}
/**
 * Runtime analysis result
 */
export interface RuntimeAnalysisResult {
    performanceMetrics: PerformanceMetric[];
    recommendations: string[];
}
/**
 * Report generation result
 */
export interface ReportResult {
    format: string;
    path: string;
    generated: Date;
}
/**
 * Dependency information
 */
export interface DependencyInfo {
    name: string;
    version: string;
    type: 'production' | 'development';
    health: 'good' | 'warning' | 'critical';
}
/**
 * Performance metric
 */
export interface PerformanceMetric {
    name: string;
    value: number;
    unit: string;
    threshold?: number;
}
/**
 * Analysis issue
 */
export interface AnalysisIssue {
    severity: 'low' | 'medium' | 'high' | 'critical';
    category: string;
    message: string;
    location?: string;
}
//# sourceMappingURL=types.d.ts.map