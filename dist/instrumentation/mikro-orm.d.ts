/**
 * MikroORM Instrumentation — auto-instrumentation for MikroORM EntityManager.
 */
export declare function createMikroORMInstrumentation(enabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
