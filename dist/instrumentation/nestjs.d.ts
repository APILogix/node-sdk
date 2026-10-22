/**
 * NestJS Core Instrumentation — auto-instrumentation for @nestjs/core.
 */
export declare function createNestJSInstrumentation(enabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
