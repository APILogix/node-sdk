import { promisify } from 'util';
import { gzip as gzipCb, brotliCompress as brotliCb, constants } from 'zlib';
const gzipAsync = promisify(gzipCb);
const brotliAsync = promisify(brotliCb);
/**
 * Compresses a buffer using gzip.
 * Uses Z_BEST_SPEED for minimal latency in hot paths.
 */
export async function compressGzip(data) {
    return gzipAsync(data, { level: constants.Z_BEST_SPEED });
}
/**
 * Compresses a buffer using Brotli.
 * Quality 1 (fastest) for real-time use.
 */
export async function compressBrotli(data) {
    return brotliAsync(data, {
        params: {
            [constants.BROTLI_PARAM_QUALITY]: 1,
        },
    });
}
/**
 * Compresses data using the specified algorithm.
 * Returns the original buffer if algorithm is 'none'.
 */
export async function compress(data, algorithm) {
    const originalSize = data.length;
    if (algorithm === 'none') {
        return { buffer: data, algorithm: 'none', originalSize, compressedSize: originalSize };
    }
    const compressor = algorithm === 'brotli' ? compressBrotli : compressGzip;
    const buffer = await compressor(data);
    // Only use compression if it actually reduced size
    if (buffer.length >= originalSize) {
        return { buffer: data, algorithm: 'none', originalSize, compressedSize: originalSize };
    }
    return { buffer, algorithm, originalSize, compressedSize: buffer.length };
}
/**
 * Returns the Content-Encoding header value for the given algorithm.
 */
export function contentEncoding(algorithm) {
    switch (algorithm) {
        case 'gzip':
            return 'gzip';
        case 'brotli':
            return 'br';
        case 'none':
            return undefined;
    }
}
//# sourceMappingURL=compression.js.map