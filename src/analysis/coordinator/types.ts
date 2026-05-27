/**
 * Coordinator Types
 * 
 * Types for the analysis coordinator
 * Validates: Requirement 20.1
 */

/**
 * Analysis coordinator configuration
 */
export interface CoordinatorConfig {
  enableStatic: boolean;
  enableRuntime: boolean;
  parallelExecution: boolean;
  timeout: number;
}

/**
 * Coordinator state
 */
export interface CoordinatorState {
  status: 'idle' | 'running' | 'completed' | 'error';
  progress: number;
  currentPhase?: string;
}