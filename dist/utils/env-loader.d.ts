/**
 * Safe Environment Variable & .env File Loader
 *
 * Provides zero-dependency .env file loading for Node.js environments:
 * 1. Checks native Node.js >= 20.6.0 `process.loadEnvFile()`.
 * 2. Provides lightweight fallback parser for older Node runtimes or custom paths.
 * 3. Never throws; fails silently if .env is missing or inaccessible.
 */
/**
 * Automatically load environment variables from the current working directory's .env file.
 * Existing process.env variables take precedence and are never overwritten.
 */
export declare function loadEnvFileSafely(customPath?: string): void;
/**
 * Parse .env content and populate process.env for unset keys.
 */
export declare function parseAndApplyEnv(content: string): void;
/**
 * Reset loader state (primarily for test isolation).
 * @internal
 */
export declare function resetEnvLoaderState(): void;
