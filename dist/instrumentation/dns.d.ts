/**
 * Node.js Native DNS Instrumentation — auto-instrumentation for node:dns.
 *
 * Captures:
 * - DNS hostname resolution latency (dns.lookup, dns.resolve)
 * - Resolved IP addresses and family (IPv4 / IPv6)
 * - Exposes DNS lookup bottlenecks in containerized / Kubernetes clusters
 */
export declare function createDNSInstrumentation(enabled: boolean): {
    enable: () => void;
    disable: () => void;
    teardown: () => void;
} | null;
