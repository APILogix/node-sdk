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
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME, } from '@opentelemetry/semantic-conventions';
let cachedResource = null;
let cachedOtelResource = null;
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
    cachedOtelResource = null;
}
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
export function detectOtelResource(service, version, environment, sdkVersion) {
    if (cachedOtelResource)
        return cachedOtelResource;
    const detected = detectResources(sdkVersion);
    const attributes = {
        // Service identity (OTel semantic conventions)
        [ATTR_SERVICE_NAME]: service,
        [ATTR_SERVICE_VERSION]: version,
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
        // SDK identity
        'telemetry.sdk.name': detected['telemetry.sdk.name'],
        'telemetry.sdk.version': detected['telemetry.sdk.version'],
        'telemetry.sdk.language': detected['telemetry.sdk.language'],
        // Process runtime
        'process.runtime.name': detected['process.runtime.name'],
        'process.runtime.version': detected['process.runtime.version'],
        'process.pid': detected['process.pid'],
        // Host
        'host.name': detected['host.name'],
        'host.arch': detected['host.arch'],
        'os.type': detected['os.type'],
        'os.platform': detected['os.platform'],
        'os.release': detected['os.release'],
        'host.cpu_count': detected['host.cpu_count'],
        'host.total_memory_mb': detected['host.total_memory_mb'],
    };
    // Optional attributes — only include if detected
    if (detected['container.id']) {
        attributes['container.id'] = detected['container.id'];
    }
    if (detected['k8s.pod.name']) {
        attributes['k8s.pod.name'] = detected['k8s.pod.name'];
    }
    if (detected['k8s.namespace.name']) {
        attributes['k8s.namespace.name'] = detected['k8s.namespace.name'];
    }
    if (detected['k8s.node.name']) {
        attributes['k8s.node.name'] = detected['k8s.node.name'];
    }
    if (detected['k8s.deployment.name']) {
        attributes['k8s.deployment.name'] = detected['k8s.deployment.name'];
    }
    if (detected['cloud.provider']) {
        attributes['cloud.provider'] = detected['cloud.provider'];
    }
    if (detected['cloud.region']) {
        attributes['cloud.region'] = detected['cloud.region'];
    }
    // Serverless detection
    const serverlessEnv = detectServerlessEnvironment();
    if (serverlessEnv) {
        attributes['faas.name'] = serverlessEnv.name;
        attributes['cloud.platform'] = serverlessEnv.platform;
    }
    // Docker detection
    if (isRunningInDocker()) {
        attributes['container.runtime'] = 'docker';
    }
    cachedOtelResource = resourceFromAttributes(attributes);
    return cachedOtelResource;
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
// ─── Serverless Detection ───────────────────────────────────────────────────
function detectServerlessEnvironment() {
    // AWS Lambda
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
        return {
            name: process.env.AWS_LAMBDA_FUNCTION_NAME,
            platform: 'aws_lambda',
        };
    }
    // Google Cloud Functions / Cloud Run
    if (process.env.K_SERVICE) {
        return {
            name: process.env.K_SERVICE,
            platform: process.env.K_REVISION ? 'gcp_cloud_run' : 'gcp_cloud_functions',
        };
    }
    // Azure Functions
    if (process.env.FUNCTIONS_WORKER_RUNTIME) {
        return {
            name: process.env.WEBSITE_SITE_NAME ?? 'unknown',
            platform: 'azure_functions',
        };
    }
    return null;
}
// ─── Docker Detection ───────────────────────────────────────────────────────
function isRunningInDocker() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs');
        return fs.existsSync('/.dockerenv');
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=resource-detector.js.map