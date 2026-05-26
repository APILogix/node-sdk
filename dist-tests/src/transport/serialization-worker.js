import { parentPort } from 'worker_threads';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'zlib';
if (parentPort) {
    parentPort.on('message', (message) => {
        const { id, events, compression } = message;
        try {
            const jsonStr = JSON.stringify(events);
            let buffer = Buffer.from(jsonStr);
            let algorithm = 'none';
            let compressedSize = buffer.length;
            const originalSize = buffer.length;
            if (compression === 'gzip') {
                const compressed = gzipSync(buffer, { level: 1 });
                if (compressed.length < buffer.length) {
                    buffer = compressed;
                    algorithm = 'gzip';
                    compressedSize = compressed.length;
                }
            }
            else if (compression === 'brotli') {
                const compressed = brotliCompressSync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } });
                if (compressed.length < buffer.length) {
                    buffer = compressed;
                    algorithm = 'brotli';
                    compressedSize = compressed.length;
                }
            }
            parentPort.postMessage({ id, buffer, algorithm, originalSize, compressedSize }, [buffer.buffer]);
        }
        catch (err) {
            parentPort.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
        }
    });
}
