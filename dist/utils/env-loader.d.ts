/**
 * Safe Environment Variable & .env File Loader
 *
 * Provides zero-dependency .env file loading for Node.js environments:
 * 1. Safely checks for local .env files without unexpected host side-effects (SEC-10).
 * 2. Only populates Pulse-scoped variables (PULSE_* and SDK_BASE_URL) during implicit loading.
 * 3. Never overwrites existing process.env variables.
 * 4. Never throws; fails silently if .env is missing or inaccessible.
 */
/**
 * Checks whether an environment variable key is scoped to the Pulse SDK.
 */
export declare function isPulseScopedKey(key: string): boolean;
/**
 * Automatically load environment variables from the current working directory's .env file.
 * Existing process.env variables take precedence and are never overwritten.
 * Implicit loading only extracts Pulse-scoped variables to avoid unexpected host side effects (SEC-10).
 */
export declare function loadEnvFileSafely(customPath?: string): void;
/**
 * Parse .env content and populate process.env for unset keys.
 */
export declare function parseAndApplyEnv(content: string, options?: {
    pulseOnly?: boolean;
}): void;
/**
 * Reset loader state (primarily for test isolation).
 * @internal
 */
export declare function resetEnvLoaderState(): void;
