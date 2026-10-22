/**
 * Sequelize Instrumentation — auto-instrumentation for Sequelize ORM.
 */
export declare function createSequelizeInstrumentation(enabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
