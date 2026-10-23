/**
 * Enterprise GPU Monitor — hardware accelerator telemetry for Node.js.
 *
 * Discovers and queries NVIDIA GPUs using non-blocking asynchronous `nvidia-smi` execution.
 * Caches presence to introduce ZERO overhead in environments without dedicated GPUs.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export class GpuMonitor {
    static instance = null;
    isAvailable = null;
    lastSnapshot = null;
    isQuerying = false;
    static getInstance() {
        if (!GpuMonitor.instance) {
            GpuMonitor.instance = new GpuMonitor();
        }
        return GpuMonitor.instance;
    }
    /**
     * Asynchronously queries GPU metrics.
     * If nvidia-smi is not available, immediately resolves with null and disables subsequent queries.
     */
    async sample() {
        if (this.isAvailable === false)
            return null;
        if (this.isQuerying)
            return this.lastSnapshot;
        this.isQuerying = true;
        try {
            const { stdout } = await execFileAsync('nvidia-smi', [
                '--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu',
                '--format=csv,noheader,nounits',
            ], { timeout: 2000 });
            this.isAvailable = true;
            const devices = [];
            let totalMemUsed = 0;
            let totalMem = 0;
            let totalUtil = 0;
            for (const line of stdout.split('\n')) {
                const parts = line.trim().split(',').map(p => p.trim());
                const p0 = parts[0];
                const p1 = parts[1];
                const p2 = parts[2];
                const p3 = parts[3];
                const p4 = parts[4];
                if (p0 !== undefined && p1 !== undefined && p2 !== undefined && p3 !== undefined && p4 !== undefined) {
                    const index = parseInt(p0, 10);
                    const util = parseFloat(p1);
                    const memUsedMb = parseFloat(p2);
                    const memTotalMb = parseFloat(p3);
                    const temp = parseFloat(p4);
                    if (!Number.isNaN(index) && !Number.isNaN(util)) {
                        const memoryUsedBytes = Math.round(memUsedMb * 1024 * 1024);
                        const memoryTotalBytes = Math.round(memTotalMb * 1024 * 1024);
                        devices.push({
                            index,
                            utilizationPercent: util,
                            memoryUsedBytes,
                            memoryTotalBytes,
                            temperatureCelsius: temp,
                        });
                        totalUtil += util;
                        totalMemUsed += memoryUsedBytes;
                        totalMem += memoryTotalBytes;
                    }
                }
            }
            if (devices.length === 0)
                return null;
            this.lastSnapshot = {
                gpuCount: devices.length,
                averageUtilizationPercent: Math.round((totalUtil / devices.length) * 100) / 100,
                totalMemoryUsedBytes: totalMemUsed,
                totalMemoryBytes: totalMem,
                devices,
            };
            return this.lastSnapshot;
        }
        catch {
            // nvidia-smi not available or query failed -> mark unavailable
            this.isAvailable = false;
            return null;
        }
        finally {
            this.isQuerying = false;
        }
    }
    getLastSnapshot() {
        return this.lastSnapshot;
    }
    reset() {
        this.isAvailable = null;
        this.lastSnapshot = null;
        this.isQuerying = false;
    }
}
export const gpuMonitor = GpuMonitor.getInstance();
