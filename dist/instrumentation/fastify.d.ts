/**
 * Compatibility shim.
 *
 * Fastify tracing is provided by OpenTelemetry FastifyInstrumentation.
 * The legacy plugin remains export-compatible but does not create spans,
 * inject propagation headers, or capture duplicate request telemetry.
 */
export interface PulseFastifyOptions {
    ignorePaths?: string[];
    captureHeaders?: boolean;
    captureQuery?: boolean;
    maxBreadcrumbs?: number;
}
type FastifyInstance = {
    addHook?(name: string, handler: (...args: unknown[]) => void): void;
};
export declare function fastifyPulsePlugin(_fastify: FastifyInstance, _opts: PulseFastifyOptions, done: (err?: Error) => void): void;
export {};
//# sourceMappingURL=fastify.d.ts.map