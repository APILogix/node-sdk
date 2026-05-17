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
import { hostname, platform, arch, type, release, cpus, totalmem } from 'os';
let cachedResource = null;
/**
 * Detect resource attributes. Results are cached — detection happens once.
 */
export function detectResources(sdkVersion) {
    if (cachedResource)
        return cachedResource;
    const resource = {
        // SDK identity
        'telemetry.sdk.name': 'pulse-sdk',
        'telemetry.sdk.version': sdkVersion,
        'telemetry.sdk.language': 'nodejs',
        // Process runtime
        'process.runtime.name': 'nodejs',
        'process.runtime.version': process.version,
        'process.pid': process.pid,
        // Host
        'host.name': hostname(),
        'host.arch': arch(),
        'os.type': type(),
        'os.platform': platform(),
        'os.release': release(),
        'host.cpu_count': cpus().length,
        'host.total_memory_mb': Math.round(totalmem() / (1024 * 1024)),
        // Container (best-effort)
        ...(detectContainerId() ? { 'container.id': detectContainerId() } : {}),
        // Kubernetes (from standard env vars)
        ...detectKubernetesMetadata(),
        // Cloud (from standard env vars)
        ...detectCloudMetadata(),
    };
    cachedResource = resource;
    return resource;
}
/**
 * Reset cached resources — for testing or reinit.
 * @internal
 */
export function resetResourceCache() {
    cachedResource = null;
}
// ─── Container Detection ────────────────────────────────────────────────────
/**
 * Attempt to detect container ID from /proc/self/cgroup (Linux).
 * Returns undefined on non-Linux or non-container environments.
 */
function detectContainerId() {
    // Check environment variable first (most reliable)
    if (process.env.CONTAINER_ID)
        return process.env.CONTAINER_ID;
    if (process.env.HOSTNAME && isContainerHostname(process.env.HOSTNAME)) {
        return process.env.HOSTNAME;
    }
    // Try reading /proc/self/cgroup (Linux-only)
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs');
        const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
        const match = cgroup.match(/[0-9a-f]{64}/);
        if (match)
            return match[0];
        // Docker uses shorter IDs in some configurations
        const shortMatch = cgroup.match(/docker\/([0-9a-f]{12,})/);
        if (shortMatch)
            return shortMatch[1];
    }
    catch {
        // Not Linux or not in a container — expected
    }
    return undefined;
}
/** Heuristic: container hostnames are typically 12+ hex chars. */
function isContainerHostname(name) {
    return /^[0-9a-f]{12,64}$/.test(name);
}
// ─── Kubernetes Detection ───────────────────────────────────────────────────
function detectKubernetesMetadata() {
    const meta = {};
    // Standard K8s downward API environment variables
    if (process.env.KUBERNETES_POD_NAME || process.env.HOSTNAME) {
        meta['k8s.pod.name'] = process.env.KUBERNETES_POD_NAME ?? process.env.HOSTNAME;
    }
    if (process.env.KUBERNETES_NAMESPACE || process.env.POD_NAMESPACE) {
        meta['k8s.namespace.name'] = process.env.KUBERNETES_NAMESPACE ?? process.env.POD_NAMESPACE;
    }
    if (process.env.KUBERNETES_NODE_NAME || process.env.NODE_NAME) {
        meta['k8s.node.name'] = process.env.KUBERNETES_NODE_NAME ?? process.env.NODE_NAME;
    }
    if (process.env.KUBERNETES_DEPLOYMENT_NAME) {
        meta['k8s.deployment.name'] = process.env.KUBERNETES_DEPLOYMENT_NAME;
    }
    return meta;
}
// ─── Cloud Detection ────────────────────────────────────────────────────────
function detectCloudMetadata() {
    const meta = {};
    // AWS
    if (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) {
        meta['cloud.provider'] = 'aws';
        meta['cloud.region'] = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    }
    // GCP
    else if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT) {
        meta['cloud.provider'] = 'gcp';
        meta['cloud.region'] = process.env.GOOGLE_CLOUD_REGION;
    }
    // Azure
    else if (process.env.AZURE_REGION || process.env.WEBSITE_SITE_NAME) {
        meta['cloud.provider'] = 'azure';
        meta['cloud.region'] = process.env.AZURE_REGION;
    }
    return meta;
}
//# sourceMappingURL=resource-detector.js.map