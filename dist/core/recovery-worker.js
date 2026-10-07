import { client } from './client.js';
import { getLogger } from '../utils/logger.js';
import { RemoteConfigClient } from './remote-config-client.js';
import { ConfigManager } from './config-manager.js';
import { classifyError, isPermanentError } from './retry-classifier.js';
import { isSDKShuttingDown } from './lifecycle.js';
export function getDefaultBaseDelayMs() {
    if (typeof process !== 'undefined' && process.env) {
        const isProduction = process.env['NODE_ENV'] === 'production' ||
            process.env['PULSE_ENV'] === 'production';
        if (!isProduction && process.env['PULSE_TEST_RECOVERY_DELAY_MS']) {
            const parsed = Number(process.env['PULSE_TEST_RECOVERY_DELAY_MS']);
            if (Number.isFinite(parsed) && parsed > 0) {
                return Math.max(10, Math.min(Math.round(parsed), 60_000));
            }
        }
    }
    return 1_000;
}
const DEFAULT_MAX_DELAY_MS = 300_000; // 5 minutes
export class BackgroundRecoveryWorker {
    static activeInstance = null;
    options;
    baseDelayMs;
    maxDelayMs;
    activateFn;
    abortController = new AbortController();
    attempt = 0;
    timer = null;
    running = false;
    stopped = false;
    constructor(options, workerOptions) {
        this.options = options;
        this.baseDelayMs = workerOptions?.baseDelayMs ?? getDefaultBaseDelayMs();
        this.maxDelayMs = workerOptions?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
        this.activateFn = workerOptions?.activateFn;
    }
    static getInstance() {
        return BackgroundRecoveryWorker.activeInstance;
    }
    static start(options, workerOptions) {
        if (BackgroundRecoveryWorker.activeInstance && !BackgroundRecoveryWorker.activeInstance.isStopped()) {
            return BackgroundRecoveryWorker.activeInstance;
        }
        const worker = new BackgroundRecoveryWorker(options, workerOptions);
        BackgroundRecoveryWorker.activeInstance = worker;
        worker.start();
        return worker;
    }
    static stop() {
        if (BackgroundRecoveryWorker.activeInstance) {
            BackgroundRecoveryWorker.activeInstance.stop();
            BackgroundRecoveryWorker.activeInstance = null;
        }
    }
    isStopped() {
        return this.stopped;
    }
    isRunning() {
        return this.running;
    }
    getAttemptCount() {
        return this.attempt;
    }
    start() {
        if (this.stopped || this.running)
            return;
        this.running = true;
        const logger = getLogger();
        logger.info('SDK entering background recovery mode.');
        this.scheduleNextAttempt();
    }
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.abortController.abort();
        if (BackgroundRecoveryWorker.activeInstance === this) {
            BackgroundRecoveryWorker.activeInstance = null;
        }
    }
    scheduleNextAttempt(retryAfterMs) {
        if (this.stopped || isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
            this.stop();
            return;
        }
        let delayMs;
        if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
            delayMs = Math.min(this.maxDelayMs, retryAfterMs);
        }
        else {
            const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, this.attempt));
            // Full jitter: [0.5, 1.5) multiplier
            const jitter = 0.5 + Math.random();
            delayMs = Math.round(Math.min(this.maxDelayMs, exponential * jitter));
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.executeAttempt();
        }, delayMs);
        // Unref timer so it does not hold the Node.js event loop open
        this.timer.unref?.();
    }
    async executeAttempt() {
        if (this.stopped || isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
            this.stop();
            return;
        }
        this.attempt++;
        const logger = getLogger();
        logger.info(`SDK recovery attempt #${this.attempt}.`);
        try {
            client.setPendingIdentity(this.options);
            const coordinator = client.singleFlightCoordinator;
            await coordinator.execute(async () => {
                if (this.abortController.signal.aborted || this.stopped || isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
                    return undefined;
                }
                const remoteClient = new RemoteConfigClient({
                    apiKey: this.options.apiKey,
                    initTimeoutMs: this.options.initTimeoutMs ?? 5_000,
                    initRetries: 0,
                });
                const initResponse = await remoteClient.initialize();
                if (!initResponse) {
                    throw new Error('Empty init response received during recovery');
                }
                if (this.stopped || isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
                    return undefined;
                }
                if (this.activateFn) {
                    await this.activateFn(initResponse);
                }
                return ConfigManager.getCurrent()?.getConfigOrNull() ?? undefined;
            });
            if (this.stopped || isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
                return;
            }
            logger.info('SDK recovery succeeded. Telemetry is now fully initialized.');
            this.stop();
        }
        catch (error) {
            if (this.stopped || isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
                return;
            }
            const decision = classifyError(error);
            if (decision.permanent || isPermanentError(error)) {
                logger.error('SDK initialization stopped: authentication/configuration error.', {
                    reason: decision.reason,
                    error,
                });
                this.stop();
                return;
            }
            // Schedule next attempt with backoff
            this.scheduleNextAttempt(decision.retryAfterMs);
        }
        finally {
            client.clearPendingIdentity();
        }
    }
}
