/** CPU profiling subsystem driven by the authoritative remote snapshot. */
import { PROFILING_DEFAULTS } from '../constants/internal-defaults.js';
import { getRequestContext } from '../core/context.js';
import { getLogger } from '../utils/logger.js';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { EntitlementGate } from '../core/entitlement-gate.js';
import { trace } from '@opentelemetry/api';
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
        this.config = resolveProfilingConfig(config);
        this.emitter = emitter;
        this.metadata = metadata;
    }
    static initialize(config, emitter, metadata) {
        ProfilingSubsystem.instance?.destroy();
        ProfilingSubsystem.instance = new ProfilingSubsystem(config, emitter, metadata);
        return ProfilingSubsystem.instance;
    }
    static getInstance() {
        return ProfilingSubsystem.instance;
    }
    updateMetadata(metadata) {
        this.metadata = metadata;
    }
    async start() {
        if (this.destroyed || !this.config.enabled || this.inspectorAvailable)
            return;
        const logger = getLogger();
        try {
            const inspector = await import('node:inspector/promises').catch(() => null);
            if (!inspector) {
                logger.warn('[ProfilingSubsystem] Inspector API not available — profiling disabled');
                return;
            }
            const session = new inspector.Session();
            session.connect();
            this.inspectorSession = session;
            this.inspectorAvailable = true;
            logger.info('[ProfilingSubsystem] Inspector session connected');
        }
        catch (error) {
            logger.warn('[ProfilingSubsystem] Failed to initialize inspector', { error });
            this.inspectorAvailable = false;
        }
    }
    async startCpuProfile(traceId, spanId) {
        if (!this.canProfile('cpu'))
            return false;
        const session = this.inspectorSession;
        if (!session)
            return false;
        const activeSpan = trace.getActiveSpan();
        const activeSpanContext = activeSpan?.spanContext();
        const resolvedTraceId = traceId ?? activeSpanContext?.traceId;
        if (!resolvedTraceId || !this.shouldProfile(resolvedTraceId))
            return false;
        const resolvedSpanId = spanId ?? activeSpanContext?.spanId;
        const requestId = getRequestContext()?.requestId;
        const key = `cpu:${resolvedTraceId}`;
        if (this.activeProfiles.has(key))
            return false;
        try {
            await session.post('Profiler.enable');
            await session.post('Profiler.start');
            const startTime = Date.now();
            const timeoutHandle = setTimeout(() => void this.stopCpuProfile(resolvedTraceId), this.config.maxDurationMs);
            timeoutHandle.unref?.();
            this.activeProfiles.set(key, {
                traceId: resolvedTraceId,
                spanId: resolvedSpanId,
                requestId,
                profileType: 'cpu',
                startTime,
                timeoutHandle,
            });
            activeSpan?.addEvent('pulse.profile.start', { 'profile.type': 'cpu', 'profile.id': key });
            activeSpan?.setAttribute('pulse.profile.active', true);
            return true;
        }
        catch (error) {
            getLogger().warn('[ProfilingSubsystem] Failed to start CPU profile', { error });
            return false;
        }
    }
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
            const scrubber = SecurityScrubber.getInstance();
            const profile = scrubber ? scrubber.scrubValue(result.profile) : result.profile;
            const event = {
                type: 'profile',
                profileType: 'cpu',
                traceId: active.traceId,
                spanId: active.spanId,
                requestId: active.requestId,
                startTime: active.startTime,
                endTime,
                duration: endTime - active.startTime,
                profile,
                timestamp: endTime,
                metadata: this.metadata,
            };
            this.emitter(event);
            const activeSpan = trace.getActiveSpan();
            if (activeSpan?.spanContext().traceId === active.traceId) {
                activeSpan.addEvent('pulse.profile.stop', {
                    'profile.type': 'cpu',
                    'profile.duration_ms': endTime - active.startTime,
                });
                activeSpan.setAttribute('pulse.profile.active', false);
            }
        }
        catch (error) {
            getLogger().warn('[ProfilingSubsystem] Failed to stop CPU profile', { error });
        }
    }
    /** Apply a validated complete snapshot selected by ConfigManager. */
    handleConfigChange(config) {
        if (!this.destroyed)
            this.config = resolveProfilingConfig(config);
    }
    async stop() {
        for (const active of this.activeProfiles.values()) {
            if (active.timeoutHandle)
                clearTimeout(active.timeoutHandle);
        }
        this.activeProfiles.clear();
        if (this.inspectorSession && this.inspectorAvailable) {
            try {
                ;
                this.inspectorSession.disconnect();
            }
            catch {
                // Best-effort teardown.
            }
        }
        this.inspectorSession = null;
        this.inspectorAvailable = false;
        getLogger().info('[ProfilingSubsystem] Stopped');
    }
    canProfile(type) {
        if (this.destroyed || !this.config.enabled || !EntitlementGate.isAllowed('profiling') || !this.inspectorAvailable)
            return false;
        return type === 'cpu' ? this.config.cpu : this.config.heap;
    }
    shouldProfile(traceId) {
        if (this.config.sampleRate >= 1)
            return true;
        if (this.config.sampleRate <= 0)
            return false;
        let hash = 2166136261;
        for (let index = 0; index < traceId.length; index++) {
            hash ^= traceId.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0) / 0x100000000 < this.config.sampleRate;
    }
    destroy() {
        void this.stop();
        this.destroyed = true;
        if (ProfilingSubsystem.instance === this)
            ProfilingSubsystem.instance = null;
    }
    static reset() {
        ProfilingSubsystem.instance?.destroy();
    }
}
function resolveProfilingConfig(config) {
    return {
        enabled: config.features.profiling,
        cpu: PROFILING_DEFAULTS.cpu,
        heap: PROFILING_DEFAULTS.heap,
        sampleRate: config.sampling.profiles,
        maxDurationMs: PROFILING_DEFAULTS.maxDurationMs,
    };
}
