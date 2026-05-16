import { promisify } from 'util'
import { gzip as gzipCb, brotliCompress as brotliCb, constants } from 'zlib'

const gzipAsync = promisify(gzipCb)
const brotliAsync = promisify(brotliCb)

export type CompressionAlgorithm = 'gzip' | 'brotli' | 'none'

/**
 * Compresses a buffer using gzip.
 * Uses Z_BEST_SPEED for minimal latency in hot paths.
 */
export async function compressGzip(data: Buffer): Promise<Buffer> {
  return gzipAsync(data, { level: constants.Z_BEST_SPEED }) as Promise<Buffer>
}

/**
 * Compresses a buffer using Brotli.
 * Quality 1 (fastest) for real-time use.
 */
export async function compressBrotli(data: Buffer): Promise<Buffer> {
  return brotliAsync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 1,
    },
  }) as Promise<Buffer>
}

/**
 * Minimum payload size for compression to be worthwhile.
 * Below this threshold, compression overhead exceeds savings.
 */
const MIN_COMPRESSION_BYTES = 1024

/**
 * Compresses data using the specified algorithm.
 * Returns the original buffer if algorithm is 'none' or payload is too small.
 */
export async function compress(
  data: Buffer,
  algorithm: CompressionAlgorithm
): Promise<{ buffer: Buffer; algorithm: CompressionAlgorithm; originalSize: number; compressedSize: number }> {
  const originalSize = data.length

  if (algorithm === 'none' || originalSize < MIN_COMPRESSION_BYTES) {
    return { buffer: data, algorithm: 'none', originalSize, compressedSize: originalSize }
  }

  const compressor = algorithm === 'brotli' ? compressBrotli : compressGzip
  const buffer = await compressor(data)

  // Only use compression if it actually reduced size
  if (buffer.length >= originalSize) {
    return { buffer: data, algorithm: 'none', originalSize, compressedSize: originalSize }
  }

  return { buffer, algorithm, originalSize, compressedSize: buffer.length }
}

/**
 * Returns the Content-Encoding header value for the given algorithm.
 */
export function contentEncoding(algorithm: CompressionAlgorithm): string | undefined {
  switch (algorithm) {
    case 'gzip':
      return 'gzip'
    case 'brotli':
      return 'br'
    case 'none':
      return undefined
  }
}
