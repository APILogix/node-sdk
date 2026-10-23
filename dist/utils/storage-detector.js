/**
 * Enterprise Storage Detector — host and volume disk capacity diagnostic engine.
 *
 * Uses Node.js built-in `statfsSync` (available in Node.js 18.15.0+) to measure
 * total volume capacity, free space, and disk utilization percentage.
 */
import { statfsSync } from 'node:fs';
export class StorageDetector {
    /**
     * Sample filesystem capacity for the specified directory mount.
     * @param targetPath - Path on the target volume (defaults to process.cwd()).
     * @returns StorageSnapshot or null if statfs is unavailable or access is restricted.
     */
    static sample(targetPath = process.cwd()) {
        try {
            if (typeof statfsSync !== 'function')
                return null;
            const stats = statfsSync(targetPath);
            const bsize = BigInt(stats.bsize);
            const totalBytesBI = bsize * BigInt(stats.blocks);
            const freeBytesBI = bsize * BigInt(stats.bfree);
            const totalBytes = Number(totalBytesBI);
            const freeBytes = Number(freeBytesBI);
            const usedBytes = Math.max(0, totalBytes - freeBytes);
            const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0;
            return {
                totalBytes,
                freeBytes,
                usedBytes,
                usedPercent,
            };
        }
        catch {
            return null;
        }
    }
}
