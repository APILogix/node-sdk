/**
 * Knex.js Instrumentation — auto-instrumentation for Knex query builder.
 */
export declare function createKnexInstrumentation(enabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
