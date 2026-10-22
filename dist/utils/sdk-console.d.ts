export declare const SDK_CONSOLE_BYPASS: unique symbol;
export declare const SDK_CONSOLE_BYPASS_LEGACY: unique symbol;
export declare function isSdkConsoleBypass(value: unknown): boolean;
export declare function sdkConsoleLog(message: string, details: Readonly<Record<string, unknown>>): void;
