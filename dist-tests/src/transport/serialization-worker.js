import { parentPort } from 'worker_threads';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'zlib';
import { SecurityScrubber } from '../processors/security-scrubber.js';
import { safeJsonStringify } from '../utils/safe-json.js';
let workerScrubber = null;
let currentPrivacyConfigJson = '';
function getOrCreateScrubber(config) {
    if (!config)
        return workerScrubber;
    try {
        const configJson = JSON.stringify(config);
        if (!workerScrubber || configJson !== currentPrivacyConfigJson) {
            currentPrivacyConfigJson = configJson;
            workerScrubber = SecurityScrubber.initialize(config);
        }
    }
    catch {
        if (!workerScrubber) {
            workerScrubber = SecurityScrubber.getInstance();
        }
    }
    return workerScrubber;
}
if (parentPort) {
    parentPort.on('message', (message) => {
        if (message?.type === 'close') {
            process.exit(0);
            return;
        }
        const { id, events, route, timestamp, privacyConfig, compression, maxPayloadBytes } = message;
        try {
            let safeEvents = events;
            if (privacyConfig && Array.isArray(events)) {
                const scrubber = getOrCreateScrubber(privacyConfig);
                if (scrubber) {
                    safeEvents = scrubber.scrubBatch(events);
                }
            }
            const payload = route
                ? { events: safeEvents, route, timestamp: timestamp ?? Date.now() }
                : safeEvents;
            const jsonStr = safeJsonStringify(payload);
            let buffer = Buffer.from(jsonStr, 'utf8');
            const originalSize = buffer.byteLength;
            if (typeof maxPayloadBytes === 'number' && maxPayloadBytes > 0 && originalSize > maxPayloadBytes) {
                try {
                    parentPort.postMessage({ id, tooLarge: true, originalSize });
                }
                catch { }
                return;
            }
            let algorithm = 'none';
            let compressedSize = originalSize;
            if (compression === 'gzip') {
                buffer = gzipSync(buffer, { level: 1 });
                algorithm = 'gzip';
                compressedSize = buffer.length;
            }
            else if (compression === 'brotli') {
                buffer = brotliCompressSync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } });
                algorithm = 'brotli';
                compressedSize = buffer.length;
            }
            const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            try {
                parentPort.postMessage({ id, buffer: Buffer.from(ab), algorithm, originalSize, compressedSize }, [ab]);
            }
            catch { }
        }
        catch (err) {
            try {
                parentPort.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
            }
            catch { }
        }
    });
}
