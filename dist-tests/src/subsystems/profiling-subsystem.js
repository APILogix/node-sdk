/**
 * ProfilingSubsystem — CPU and heap profiling driven by remote config.
 *
 * Behavior:
 * - Only started when features.profiling = true AND profiling.enabled = true.
 * - CPU profiling: Uses Node.js inspector API to capture V8 CPU profiles.
 * - Heap profiling: Uses Node.js inspector API for heap snapshots.
 * - sampleRate: FNV-1a hash on traceId decides whether to profile a request.
 * - maxDurationMs: Hard cap on individual profile duration.
 * - Emits ProfileEvent objects to transport layer.
 * - Killswitch: disableProfiling → stop inspector, flush in-flight profiles.
 *
 * Note: The inspector API requires --inspect flag or explicit Session creation.
 * The subsystem gracefully degrades if inspector is not available.
 */
import { getLogger } from '../utils/logger.js';
export class ProfilingSubsystem {
    static instance = null;
    config;
    emitter;
    metadata;
    activeProfiles = new Map();
    inspectorSession = null;
    inspectorAvailable = false;
    destroyed = false;
    constructor(config, emitter, metadata) {
        this.config = { ...config };
        this.emitter = emitter;
        this.metadata = metadata;
    }
    static initialize(config, emitter, metadata) {
        if (ProfilingSubsystem.instance) {
            ProfilingSubsystem.instance.destroy();
        }
        ProfilingSubsystem.instance = new ProfilingSubsystem(config, emitter, metadata);
        return ProfilingSubsystem.instance;
    }
    static getInstance() {
        return ProfilingSubsystem.instance;
    }
    /** Initialize the inspector session. */
    async start() {
        if (this.destroyed || !this.config.enabled)
            return;
        const logger = getLogger();
        try {
            // Dynamic import to avoid requiring inspector at load time
            const inspector = await import('node:inspector/promises').catch(() => null);
            if (inspector) {
                const session = new inspector.Session();
                session.connect();
                this.inspectorSession = session;
                this.inspectorAvailable = true;
                logger.info('[ProfilingSubsystem] Inspector session connected');
            }
            else {
                logger.warn('[ProfilingSubsystem] Inspector API not available — profiling disabled');
                this.inspectorAvailable = false;
            }
        }
        catch (err) {
            logger.warn(`[ProfilingSubsystem] Failed to initialize inspector: ${err instanceof Error ? err.message : String(err)}`);
            this.inspectorAvailable = false;
        }
    }
    /**
     * Start a CPU profile for the given trace.
     * Call this at the beginning of a request if sampling decides to profile.
     */
    async startCpuProfile(traceId, spanId) {
        if (!this.canProfile('cpu'))
            return false;
        const session = this.inspectorSession;
        if (!session)
            return false;
        const key = `cpu:${traceId}`;
        if (this.activeProfiles.has(key))
            return false;
        try {
            await session.post('Profiler.enable');
            await session.post('Profiler.start');
            const startTime = Date.now();
            const timeoutHandle = setTimeout(() => {
                void this.stopCpuProfile(traceId);
            }, this.config.maxDurationMs);
            if (typeof timeoutHandle === 'object' && 'unref' in timeoutHandle) {
                ;
                timeoutHandle.unref();
            }
            this.activeProfiles.set(key, {
                traceId,
                spanId,
                profileType: 'cpu',
                startTime,
                timeoutHandle,
            });
            return true;
        }
        catch (err) {
            getLogger().warn(`[ProfilingSubsystem] Failed to start CPU profile: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    /**
     * Stop a CPU profile and emit the ProfileEvent.
     */
    async stopCpuProfile(traceId) {
        const key = `cpu:${traceId}`;
        const active = this.activeProfiles.get(key);
        if (!active)
            return;
        this.activeProfiles.delete(key);
        if (active.timeoutHandle)
            clearTimeout(active.timeoutHandle);
        const session = this.inspectorSession;
        if (!session)
            return;
        try {
            const result = await session.post('Profiler.stop');
            const endTime = Date.now();
            const event = {
                type: 'profile',
                profileType: 'cpu',
                traceId: active.traceId,
                spanId: active.spanId,
                startTime: active.startTime,
                endTime,
                duration: endTime - active.startTime,
                profile: result.profile,
                timestamp: endTime,
                metadata: this.metadata,
            };
            this.emitter(event);
        }
        catch (err) {
            getLogger().warn(`[ProfilingSubsystem] Failed to stop CPU profile: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** Handle config change. */
    handleConfigChange(_diff, newConfig) {
        if (this.destroyed)
            return;
        this.config = { ...newConfig.profiling };
    }
    /** Stop all active profiles and disconnect inspector. */
    async stop() {
        // Stop all active profiles
        for (const [key, active] of this.activeProfiles) {
            if (active.timeoutHandle)
                clearTimeout(active.timeoutHandle);
            this.activeProfiles.delete(key);
        }
        // Disconnect inspector
        if (this.inspectorSession && this.inspectorAvailable) {
            try {
                const session = this.inspectorSession;
                session.disconnect();
            }
            catch {
                // Ignore disconnect errors
            }
            this.inspectorSession = null;
            this.inspectorAvailable = false;
        }
        getLogger().info('[ProfilingSubsystem] Stopped');
    }
    canProfile(type) {
        if (this.destroyed || !this.config.enabled || !this.inspectorAvailable)
            return false;
        if (type === 'cpu' && !this.config.cpu)
            return false;
        if (type === 'heap' && !this.config.heap)
            return false;
        return true;
    }
    destroy() {
        void this.stop();
        this.destroyed = true;
        ProfilingSubsystem.instance = null;
    }
    static reset() {
        if (ProfilingSubsystem.instance) {
            ProfilingSubsystem.instance.destroy();
        }
    }
}
