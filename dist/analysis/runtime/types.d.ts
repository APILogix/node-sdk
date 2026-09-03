/**
 * Runtime Analysis Types
 *
 * Types for runtime behavior analysis
 * Validates: Requirement 20.1
 */
/**
 * Runtime analysis result
 */
export interface RuntimeAnalysisResult {
    performanceMetrics: PerformanceMetric[];
    memoryAnalysis: MemoryAnalysis;
    recommendations: string[];
}
/**
 * Performance metric
 */
export interface PerformanceMetric {
    name: string;
    value: number;
    unit: string;
    threshold?: number;
    status: 'ok' | 'warning' | 'critical';
}
/**
 * Memory analysis result
 */
export interface MemoryAnalysis {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
}
/**
 * Recommendation
 */
export interface Recommendation {
    priority: 'low' | 'medium' | 'high';
    category: string;
    message: string;
    estimatedImpact?: string;
}
