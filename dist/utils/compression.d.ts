export type CompressionAlgorithm = 'gzip' | 'brotli' | 'none';
/**
 * Compresses a buffer using gzip.
 * Uses Z_BEST_SPEED for minimal latency in hot paths.
 */
export declare function compressGzip(data: Buffer): Promise<Buffer>;
/**
 * Compresses a buffer using Brotli.
 * Quality 1 (fastest) for real-time use.
 */
export declare function compressBrotli(data: Buffer): Promise<Buffer>;
/**
 * Compresses data using the specified algorithm.
 * Returns the original buffer if algorithm is 'none' or payload is too small.
 */
export declare function compress(data: Buffer, algorithm: CompressionAlgorithm): Promise<{
    buffer: Buffer;
    algorithm: CompressionAlgorithm;
    originalSize: number;
    compressedSize: number;
}>;
/**
 * Returns the Content-Encoding header value for the given algorithm.
 */
export declare function contentEncoding(algorithm: CompressionAlgorithm): string | undefined;
