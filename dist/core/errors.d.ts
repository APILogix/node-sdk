export declare class SDKError extends Error {
    readonly code: string;
    readonly context: Record<string, unknown>;
    constructor(message: string, code: string, context?: Record<string, unknown>, cause?: unknown);
}
export declare function toError(value: unknown): Error;
export declare function extractErrorCauseChain(error: unknown, maxDepth?: number): Array<{
    name: string;
    message: string;
    stack?: string;
}>;
