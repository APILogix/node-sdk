/**
 * Static Analysis Types
 *
 * Types for static code analysis
 * Validates: Requirement 20.1
 */
/**
 * Static analysis result
 */
export interface StaticAnalysisResult {
    architectureScore: number;
    modules: ModuleInfo[];
    dependencies: DependencyInfo[];
    issues: AnalysisIssue[];
}
/**
 * Module information
 */
export interface ModuleInfo {
    path: string;
    exports: string[];
    imports: string[];
    complexity: number;
}
/**
 * Dependency information
 */
export interface DependencyInfo {
    name: string;
    version: string;
    type: 'production' | 'development';
    health: 'good' | 'warning' | 'critical';
    usages: number;
}
/**
 * Analysis issue
 */
export interface AnalysisIssue {
    severity: 'low' | 'medium' | 'high' | 'critical';
    category: string;
    message: string;
    location?: string;
    code?: string;
}
//# sourceMappingURL=types.d.ts.map