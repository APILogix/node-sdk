/** CPU and Heap profiling subsystem driven by the authoritative remote snapshot. */
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
    activeCpuProfileKey = null;
    activeHeapProfileKey = null;
    inspectorSession = null;
    inspectorAvailable = false;
    destroyed = false;
    // Continuous wall-clock profiling state
    continuousTimer = null;
    coolingTimer = null;
    continuousChunkStartTime = 0;
    isContinuousRunning = false;
    isCooling = false;
    activeTracesInChunk = new Set();
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
        if (this.destroyed || !this.config.enabled)
            return;
        if (this.inspectorAvailable) {
            if (this.config.continuous && this.canProfile('cpu')) {
                await this.startContinuousProfiling();
            }
            return;
        }
        const logger = getLogger();
        try {
            let session = null;
            try {
                const inspectorPromises = await import('node:inspector/promises');
                const s = new inspectorPromises.Session();
                s.connect();
                session = s;
            }
            catch {
                const inspector = await import('node:inspector');
                const rawSession = new inspector.Session();
                rawSession.connect();
                session = {
                    post: (method, params) => new Promise((resolve, reject) => {
                        if (typeof params === 'object' && params !== null) {
                            rawSession.post(method, params, (err, res) => {
                                if (err)
                                    reject(err);
                                else
                                    resolve(res);
                            });
                        }
                        else {
                            rawSession.post(method, (err, res) => {
                                if (err)
                                    reject(err);
                                else
                                    resolve(res);
                            });
                        }
                    }),
                    disconnect: () => rawSession.disconnect(),
                };
            }
            this.inspectorSession = session;
            this.inspectorAvailable = true;
            logger.info('[ProfilingSubsystem] Inspector session connected');
            // If continuous wall-clock profiling is enabled by remote config, launch immediately
            if (this.config.continuous && this.canProfile('cpu')) {
                await this.startContinuousProfiling();
            }
        }
        catch (error) {
            logger.warn('[ProfilingSubsystem] Failed to initialize inspector', { error });
            this.inspectorAvailable = false;
        }
    }
    /**
     * Starts continuous wall-clock CPU sampling driven by remote config.
     * Periodically flushes chunked profiles to the backend ingestion queue.
     */
    async startContinuousProfiling() {
        if (this.destroyed || !this.config.enabled || !EntitlementGate.isAllowed('profiling') || !this.inspectorAvailable) {
            return false;
        }
        if (this.isContinuousRunning)
            return true;
        const session = this.inspectorSession;
        if (!session)
            return false;
        try {
            await session.post('Profiler.enable');
            if (this.config.sampleIntervalMicroseconds > 0) {
                await session.post('Profiler.setSamplingInterval', { interval: this.config.sampleIntervalMicroseconds });
            }
            await session.post('Profiler.start');
            this.isContinuousRunning = true;
            this.isCooling = false;
            this.continuousChunkStartTime = Date.now();
            this.activeTracesInChunk.clear();
            this.scheduleNextContinuousChunk();
            getLogger().info('[ProfilingSubsystem] Continuous wall-clock CPU profiling started', {
                intervalMs: this.config.continuousIntervalMs,
                coolingIntervalMs: this.config.coolingIntervalMs,
                sampleRateHz: this.config.sampleRateHz,
            });
            return true;
        }
        catch (error) {
            getLogger().warn('[ProfilingSubsystem] Failed to start continuous CPU profiling', { error });
            this.isContinuousRunning = false;
            this.isCooling = false;
            return false;
        }
    }
    scheduleNextContinuousChunk() {
        if (this.continuousTimer)
            clearTimeout(this.continuousTimer);
        this.continuousTimer = setTimeout(() => {
            void this.flushContinuousChunk();
        }, this.config.continuousIntervalMs);
        this.continuousTimer.unref?.();
    }
    /**
     * Stops the current continuous profiling chunk, emits the profile event,
     * and restarts the next chunk after any enforced cooling interval.
     */
    async flushContinuousChunk() {
        if (!this.isContinuousRunning)
            return;
        const session = this.inspectorSession;
        if (!session)
            return;
        if (this.isCooling)
            return;
        try {
            const result = await session.post('Profiler.stop');
            const endTime = Date.now();
            const chunkDuration = endTime - this.continuousChunkStartTime;
            const traceIds = Array.from(this.activeTracesInChunk);
            this.activeTracesInChunk.clear();
            this.continuousChunkStartTime = endTime;
            const restartContinuousProfiler = async () => {
                if (!this.isContinuousRunning)
                    return;
                this.isCooling = false;
                this.continuousChunkStartTime = Date.now();
                try {
                    await session.post('Profiler.start');
                }
                catch (startErr) {
                    getLogger().debug('[ProfilingSubsystem] Failed to restart continuous profiler chunk', { error: startErr });
                }
                this.scheduleNextContinuousChunk();
            };
            // Enforce cooling duty cycle if configured
            if (this.config.coolingIntervalMs > 0) {
                this.isCooling = true;
                if (this.coolingTimer)
                    clearTimeout(this.coolingTimer);
                this.coolingTimer = setTimeout(() => {
                    this.coolingTimer = null;
                    void restartContinuousProfiler();
                }, this.config.coolingIntervalMs);
                this.coolingTimer.unref?.();
            }
            else {
                await restartContinuousProfiler();
            }
            const scrubber = SecurityScrubber.getInstance();
            const profile = scrubber ? scrubber.scrubValue(result?.profile) : result?.profile;
            const event = {
                type: 'profile',
                profileType: 'cpu',
                startTime: endTime - chunkDuration,
                endTime,
                duration: chunkDuration,
                profile,
                timestamp: endTime,
                metadata: this.metadata,
                isContinuous: true,
                sampleRateHz: this.config.sampleRateHz,
                activeTraceIds: traceIds.length > 0 ? traceIds : undefined,
            };
            this.emitter(event);
        }
        catch (error) {
            if (isNoRecordingProfilesError(error)) {
                getLogger().debug('[ProfilingSubsystem] Continuous chunk was already stopped', { error });
            }
            else {
                getLogger().warn('[ProfilingSubsystem] Failed to flush continuous CPU profile chunk', { error });
            }
        }
    }
    /**
     * Stops the continuous profiling loop and shuts down the V8 profiler.
     */
    async stopContinuousProfiling() {
        if (this.continuousTimer) {
            clearTimeout(this.continuousTimer);
            this.continuousTimer = null;
        }
        if (this.coolingTimer) {
            clearTimeout(this.coolingTimer);
            this.coolingTimer = null;
        }
        if (!this.isContinuousRunning)
            return;
        const wasCooling = this.isCooling;
        this.isContinuousRunning = false;
        this.isCooling = false;
        const session = this.inspectorSession;
        if (session && !wasCooling) {
            try {
                await session.post('Profiler.stop');
            }
            catch (error) {
                if (!isNoRecordingProfilesError(error)) {
                    getLogger().debug('[ProfilingSubsystem] Profiler.stop error during continuous teardown', { error });
                }
            }
        }
        this.activeTracesInChunk.clear();
    }
    /**
     * Correlates an active traceId with the current continuous profiling chunk.
     */
    recordActiveTrace(traceId) {
        if (this.isContinuousRunning && traceId) {
            this.activeTracesInChunk.add(traceId);
        }
    }
    /**
     * Returns whether continuous wall-clock profiling is currently running.
     */
    isContinuousActive() {
        return this.isContinuousRunning;
    }
    /**
     * Returns whether continuous profiling is currently in a cooling-off interval.
     */
    isContinuousCooling() {
        return this.isCooling;
    }
    /**
     * Returns current continuous profiling configuration.
     */
    getContinuousConfig() {
        return {
            continuous: this.config.continuous,
            intervalMs: this.config.continuousIntervalMs,
            sampleRateHz: this.config.sampleRateHz,
            coolingIntervalMs: this.config.coolingIntervalMs,
        };
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
        if (this.activeCpuProfileKey !== null)
            return false;
        if (this.activeProfiles.has(key))
            return false;
        // If continuous profiling is active, record the trace association and let continuous profiling track it
        if (this.isContinuousRunning) {
            this.recordActiveTrace(resolvedTraceId);
            activeSpan?.addEvent('lynktrace.profile.continuous', { 'profile.type': 'cpu', 'profile.id': key });
            activeSpan?.addEvent('pulse.profile.continuous', { 'profile.type': 'cpu', 'profile.id': key });
            activeSpan?.setAttribute('lynktrace.profile.active', true);
            activeSpan?.setAttribute('pulse.profile.active', true);
            activeSpan?.setAttribute('lynktrace.profile.continuous', true);
            activeSpan?.setAttribute('pulse.profile.continuous', true);
            return true;
        }
        try {
            await session.post('Profiler.enable');
            await session.post('Profiler.start');
            this.activeCpuProfileKey = key;
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
            activeSpan?.addEvent('lynktrace.profile.start', { 'profile.type': 'cpu', 'profile.id': key });
            activeSpan?.addEvent('pulse.profile.start', { 'profile.type': 'cpu', 'profile.id': key });
            activeSpan?.setAttribute('lynktrace.profile.active', true);
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
        if (this.activeCpuProfileKey !== key)
            return;
        this.activeProfiles.delete(key);
        if (active.timeoutHandle)
            clearTimeout(active.timeoutHandle);
        const session = this.inspectorSession;
        if (!session) {
            this.activeCpuProfileKey = null;
            return;
        }
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
                activeSpan.addEvent('lynktrace.profile.stop', {
                    'profile.type': 'cpu',
                    'profile.duration_ms': endTime - active.startTime,
                });
                activeSpan.addEvent('pulse.profile.stop', {
                    'profile.type': 'cpu',
                    'profile.duration_ms': endTime - active.startTime,
                });
                activeSpan.setAttribute('lynktrace.profile.active', false);
                activeSpan.setAttribute('pulse.profile.active', false);
            }
        }
        catch (error) {
            const logger = getLogger();
            if (isNoRecordingProfilesError(error)) {
                logger.debug('[ProfilingSubsystem] CPU profile was already stopped', { error });
            }
            else {
                logger.warn('[ProfilingSubsystem] Failed to stop CPU profile', { error });
            }
        }
        finally {
            this.activeCpuProfileKey = null;
        }
    }
    /**
     * Starts a heap allocation profile using the V8 SamplingHeapProfiler.
     */
    async startHeapProfile(traceId, spanId) {
        if (!this.canProfile('heap'))
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
        const key = `heap:${resolvedTraceId}`;
        if (this.activeHeapProfileKey !== null)
            return false;
        if (this.activeProfiles.has(key))
            return false;
        try {
            await session.post('HeapProfiler.enable');
            await session.post('HeapProfiler.startSampling', { samplingInterval: 524288 });
            this.activeHeapProfileKey = key;
            const startTime = Date.now();
            const timeoutHandle = setTimeout(() => void this.stopHeapProfile(resolvedTraceId), this.config.maxDurationMs);
            timeoutHandle.unref?.();
            this.activeProfiles.set(key, {
                traceId: resolvedTraceId,
                spanId: resolvedSpanId,
                requestId,
                profileType: 'heap',
                startTime,
                timeoutHandle,
            });
            activeSpan?.addEvent('pulse.profile.heap.start', { 'profile.type': 'heap', 'profile.id': key });
            return true;
        }
        catch (error) {
            getLogger().warn('[ProfilingSubsystem] Failed to start heap profile', { error });
            return false;
        }
    }
    /**
     * Stops a heap allocation profile and emits the profile event.
     */
    async stopHeapProfile(traceId) {
        const key = `heap:${traceId}`;
        const active = this.activeProfiles.get(key);
        if (!active)
            return;
        if (this.activeHeapProfileKey !== key)
            return;
        this.activeProfiles.delete(key);
        if (active.timeoutHandle)
            clearTimeout(active.timeoutHandle);
        const session = this.inspectorSession;
        if (!session) {
            this.activeHeapProfileKey = null;
            return;
        }
        try {
            const result = await session.post('HeapProfiler.stopSampling');
            const endTime = Date.now();
            const scrubber = SecurityScrubber.getInstance();
            const profile = scrubber ? scrubber.scrubValue(result.profile) : result.profile;
            const event = {
                type: 'profile',
                profileType: 'heap',
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
                activeSpan.addEvent('pulse.profile.heap.stop', {
                    'profile.type': 'heap',
                    'profile.duration_ms': endTime - active.startTime,
                });
            }
        }
        catch (error) {
            getLogger().warn('[ProfilingSubsystem] Failed to stop heap profile', { error });
        }
        finally {
            this.activeHeapProfileKey = null;
        }
    }
    /** Apply a validated complete snapshot selected by ConfigManager. */
    handleConfigChange(config) {
        if (this.destroyed)
            return;
        const prevContinuous = this.config.continuous;
        const prevInterval = this.config.continuousIntervalMs;
        const prevCooling = this.config.coolingIntervalMs;
        this.config = resolveProfilingConfig(config);
        // Dynamic continuous profiling transition driven by remote config
        if (!prevContinuous && this.config.continuous) {
            if (this.inspectorAvailable && this.canProfile('cpu')) {
                void this.startContinuousProfiling();
            }
        }
        else if (prevContinuous && !this.config.continuous) {
            void this.stopContinuousProfiling();
        }
        else if (this.isContinuousRunning && (prevInterval !== this.config.continuousIntervalMs || prevCooling !== this.config.coolingIntervalMs)) {
            // Re-arm timer with updated interval/cooling from remote config
            if (this.continuousTimer)
                clearTimeout(this.continuousTimer);
            if (this.coolingTimer)
                clearTimeout(this.coolingTimer);
            this.isCooling = false;
            this.continuousTimer = setTimeout(() => {
                void this.flushContinuousChunk();
            }, this.config.continuousIntervalMs);
            this.continuousTimer.unref?.();
        }
    }
    async stop() {
        await this.stopContinuousProfiling();
        for (const active of this.activeProfiles.values()) {
            if (active.timeoutHandle)
                clearTimeout(active.timeoutHandle);
        }
        this.activeProfiles.clear();
        this.activeCpuProfileKey = null;
        this.activeHeapProfileKey = null;
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
function isNoRecordingProfilesError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('No recording profiles found');
}
function resolveProfilingConfig(config) {
    const continuous = Boolean(config.profiling?.continuous ?? config.features?.continuousProfiling ?? false);
    const sampleRateHz = config.profiling?.sampleRateHz ?? PROFILING_DEFAULTS.continuousSampleRateHz;
    const sampleIntervalMicroseconds = config.profiling?.sampleIntervalMicroseconds ??
        (sampleRateHz > 0 ? Math.round(1_000_000 / sampleRateHz) : PROFILING_DEFAULTS.sampleIntervalMicroseconds);
    const coolingIntervalMs = Math.max(0, config.profiling?.coolingIntervalMs ??
        config.profiling?.continuousCoolingMs ??
        config.features?.continuousCoolingMs ??
        PROFILING_DEFAULTS.coolingIntervalMs);
    return {
        enabled: config.features.profiling,
        cpu: PROFILING_DEFAULTS.cpu,
        heap: PROFILING_DEFAULTS.heap,
        sampleRate: config.sampling.profiles,
        maxDurationMs: config.profiling?.maxDurationMs ?? PROFILING_DEFAULTS.maxDurationMs,
        continuous,
        continuousIntervalMs: config.profiling?.continuousIntervalMs ?? PROFILING_DEFAULTS.continuousIntervalMs,
        coolingIntervalMs,
        sampleIntervalMicroseconds,
        sampleRateHz,
    };
}
