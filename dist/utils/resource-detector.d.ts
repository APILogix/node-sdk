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
 * OpenTelemetry owns host/process/os/env detection. The SDK adds product
 * identity plus fallback container, Kubernetes, and cloud hints.
 */
import { type Resource } from '@opentelemetry/resources';
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
/**
 * Detect and create an OTel Resource with all available metadata.
 * Merges host, process, service, container, cloud, and K8s attributes.
 * Results are cached — detection happens once.
 *
 * @param service - Service name
 * @param version - Service version (release)
 * @param environment - Deployment environment
 * @param sdkVersion - SDK version string
 */
export declare function detectOtelResource(service: string, version: string, environment: string, sdkVersion: string): Resource;
