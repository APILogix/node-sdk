/**
 * Resource Detector — automatically discovers runtime, host, and container
 * metadata for attaching to telemetry events.
 *
 * Detects:
 * - Node.js runtime version
 * - OS type, platform, architecture
 * - Hostname and process info
 * - Container ID (Docker/K8s via /proc/self/cgroup)
 * - Kubernetes metadata (via environment variables)
 * - Cloud provider hints (via well-known env vars)
 *
 * This module is modeled after OpenTelemetry's Resource Detectors but
 * with zero external dependencies.
 */
export interface ResourceAttributes {
    /** SDK telemetry source */
    readonly 'telemetry.sdk.name': string;
    readonly 'telemetry.sdk.version': string;
    readonly 'telemetry.sdk.language': string;
    /** Process info */
    readonly 'process.runtime.name': string;
    readonly 'process.runtime.version': string;
    readonly 'process.pid': number;
    /** Host info */
    readonly 'host.name': string;
    readonly 'host.arch': string;
    readonly 'os.type': string;
    readonly 'os.platform': string;
    readonly 'os.release': string;
    readonly 'host.cpu_count': number;
    readonly 'host.total_memory_mb': number;
    /** Container (optional) */
    readonly 'container.id'?: string;
    /** Kubernetes (optional) */
    readonly 'k8s.pod.name'?: string;
    readonly 'k8s.namespace.name'?: string;
    readonly 'k8s.node.name'?: string;
    readonly 'k8s.deployment.name'?: string;
    /** Cloud (optional) */
    readonly 'cloud.provider'?: string;
    readonly 'cloud.region'?: string;
}
/**
 * Detect resource attributes. Results are cached — detection happens once.
 */
export declare function detectResources(sdkVersion: string): ResourceAttributes;
/**
 * Reset cached resources — for testing or reinit.
 * @internal
 */
export declare function resetResourceCache(): void;
//# sourceMappingURL=resource-detector.d.ts.map