/**
 * Analysis Module
 *
 * Provides SDK architecture analysis capabilities including:
 * - Static code analysis
 * - Runtime behavior analysis
 * - Coordinated analysis orchestration
 * - Report generation
 *
 * Validates: Requirement 20.1
 */
// Re-export types
export * from './types.js';
// Re-export sub-modules
export * from './coordinator/index.js';
export * from './static/index.js';
export * from './runtime/index.js';
export * from './reports/index.js';
/**
 * Analysis module version
 */
export const ANALYSIS_MODULE_VERSION = '1.0.0';
//# sourceMappingURL=index.js.map