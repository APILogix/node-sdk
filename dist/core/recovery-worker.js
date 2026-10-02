import { client } from './client.js';
import { getLogger } from '../utils/logger.js';
import { RemoteConfigClient } from './remote-config-client.js';
import { ConfigManager } from './config-manager.js';
import { classifyError, isPermanentError } from './retry-classifier.js';
import { isSDKShuttingDown } from './lifecycle.js';
const DEFAULT_BASE_DELAY_MS = 1_000;
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
        this.baseDelayMs = workerOptions?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
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
        logger.info('[Pulse] SDK entering background recovery mode.');
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
        if (this.stopped || isSDKShuttingDown() || client.getState() === 'stopped') {
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
        if (this.stopped || isSDKShuttingDown() || client.getState() === 'stopped') {
            this.stop();
            return;
        }
        this.attempt++;
        const logger = getLogger();
        logger.info(`[Pulse] SDK recovery attempt #${this.attempt}.`);
        try {
            const coordinator = client.singleFlightCoordinator;
            await coordinator.execute(async () => {
                if (this.abortController.signal.aborted) {
                    throw new Error('Recovery aborted');
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
                if (this.stopped || isSDKShuttingDown()) {
                    return undefined;
                }
                if (this.activateFn) {
                    await this.activateFn(initResponse);
                }
                return ConfigManager.getCurrent()?.getConfigOrNull() ?? undefined;
            });
            if (this.stopped || isSDKShuttingDown()) {
                return;
            }
            logger.info('[Pulse] SDK recovery succeeded. Telemetry is now fully initialized.');
            this.stop();
        }
        catch (error) {
            if (this.stopped || isSDKShuttingDown()) {
                return;
            }
            const decision = classifyError(error);
            if (decision.permanent || isPermanentError(error)) {
                logger.error('[Pulse] SDK initialization stopped: authentication/configuration error.', {
                    reason: decision.reason,
                    error,
                });
                this.stop();
                return;
            }
            // Schedule next attempt with backoff
            this.scheduleNextAttempt(decision.retryAfterMs);
        }
    }
}
