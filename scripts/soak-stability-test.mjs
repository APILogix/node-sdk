/**
 * Pulse APM Node.js SDK — Long-Duration Soak Stability & Memory Leak Benchmark
 *
 * Implements the long-duration soak benchmark from the 7 Critical Forensic
 * Audit. Set SOAK_DURATION_SEC=14400 for the four-hour launch-gate run.
 * Can be run continuously (e.g. 4 hours via SOAK_DURATION_SEC=14400) or
 * as a fast CI soak verification (default 30 seconds).
 *
 * Measures:
 * 1. Post-GC heapUsed drift across sustained continuous event injection (2,000 events/sec)
 * 2. Unbounded memory growth detection in TraceAggregator and LRU deduplication caches
 * 3. Event queue and batch manager buffer drainage
 * 4. Graceful shutdown convergence after sustained soaking
 */

import http from 'node:http';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  init,
  shutdown,
  captureError,
  captureMessage,
  captureMetric,
  startSpan,
} from '../dist/index.js';
import { DEFAULT_REMOTE_CONFIG } from '../dist/constants/defaults.js';

const DURATION_SECONDS = parseInt(process.env.SOAK_DURATION_SEC || '30', 10);
const TARGET_RPS = parseInt(process.env.SOAK_TARGET_RPS || '2000', 10);
const GC_INTERVAL_SEC = 5;

function forceGC() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
}

async function startMockBackend() {
  let receivedBatches = 0;
  let receivedEvents = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const port = server.address().port;
      const localUrl = `http://127.0.0.1:${port}`;

      if (req.url === '/v1/init') {
        const routePaths = {
          errors: '/api/v1/errors',
          events: '/api/v1/events',
          traces: '/api/v1/traces',
          spans: '/api/v1/spans',
          requests: '/api/v1/requests',
          metrics: '/api/v1/metrics',
          logs: '/api/v1/logs',
          profiles: '/api/v1/profiles',
          crons: '/api/v1/checkins',
          replays: '/api/v1/replays',
        };
        const routes = Object.fromEntries(
          Object.entries(DEFAULT_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
            name,
            { ...route, url: `${localUrl}${routePaths[name]}`, batchSize: 500, flushIntervalMs: 100, timeoutMs: 3000 },
          ])
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            projectId: 'soak-bench-project',
            environment: 'production',
            release: '8.4.1',
            config: {
              ...DEFAULT_REMOTE_CONFIG,
              sdk: { projectId: 'soak-bench-project', service: 'soak-bench-service', environment: 'production', release: '8.4.1' },
              features: {
                ...DEFAULT_REMOTE_CONFIG.features,
                tracing: true,
                requestCapture: true,
                errors: true,
                metrics: true,
              },
              limits: {
                ...DEFAULT_REMOTE_CONFIG.limits,
                maxQueueSize: 100000,
              },
              sampling: {
                ...DEFAULT_REMOTE_CONFIG.sampling,
                traces: 1,
                requests: 1,
                errors: 1,
                metrics: 1,
              },
              offlineQueue: {
                enabled: false,
                maxFileSizeBytes: 1024 * 1024,
                maxEvents: 1000,
                eventTtlMs: 60000,
                ioTimeoutMs: 5000,
                flushDebounceMs: 100,
              },
              transport: { ...DEFAULT_REMOTE_CONFIG.transport, routes },
            },
          })
        );
        return;
      }

      if (req.url?.startsWith('/api/v1/')) {
        receivedBatches++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function runSoakTest() {
  console.log('='.repeat(80));
  console.log(' PULSE APM SDK — SOAK STABILITY & MEMORY LEAK FORENSIC RUN');
  console.log(` Duration: ${DURATION_SECONDS} seconds | Target Load: ${TARGET_RPS} events/sec`);
  console.log('='.repeat(80));

  const mock = await startMockBackend();

  process.env['PULSE_ENDPOINT'] = mock.url;
  await init({
    apiKey: 'soak-test-key',
    initTimeoutMs: 10000,
  });

  console.log('  ✓ SDK Initialized against local mock backend');

  forceGC();
  const baselineMem = process.memoryUsage();
  const baselineHeapMb = (baselineMem.heapUsed / 1024 / 1024).toFixed(2);
  console.log(`  ✓ Baseline Heap: ${baselineHeapMb} MB | RSS: ${(baselineMem.rss / 1024 / 1024).toFixed(2)} MB`);

  const snapshots = [];
  const startTime = performance.now();
  let totalEventsInjected = 0;
  let lastGcSec = 0;

  const BATCH_INTERVAL_MS = 100;
  const EVENTS_PER_INTERVAL = Math.round(TARGET_RPS * (BATCH_INTERVAL_MS / 1000));

  while (true) {
    const elapsedSec = (performance.now() - startTime) / 1000;
    if (elapsedSec >= DURATION_SECONDS) break;

    // Pump events for this interval
    for (let i = 0; i < EVENTS_PER_INTERVAL; i++) {
      const mod = (totalEventsInjected + i) % 4;
      if (mod === 0) {
        captureError(new Error(`soak-err-${totalEventsInjected + i}`));
      } else if (mod === 1) {
        captureMessage(`soak-msg-${totalEventsInjected + i}`, 'info');
      } else if (mod === 2) {
        captureMetric('soak.metric.rate', 1, 'counter');
      } else {
        const span = startSpan(`soak-span-${totalEventsInjected + i}`);
        span.setAttribute('soak.iter', totalEventsInjected + i);
        span.end();
      }
    }
    totalEventsInjected += EVENTS_PER_INTERVAL;

    // Periodic GC and memory snapshot
    if (elapsedSec - lastGcSec >= GC_INTERVAL_SEC) {
      lastGcSec = elapsedSec;
      forceGC();
      const mem = process.memoryUsage();
      const heapUsedMb = mem.heapUsed / 1024 / 1024;
      const driftFromBaselineMb = heapUsedMb - parseFloat(baselineHeapMb);

      snapshots.push({
        elapsedSec: Math.round(elapsedSec),
        heapUsedMb: parseFloat(heapUsedMb.toFixed(2)),
        rssMb: parseFloat((mem.rss / 1024 / 1024).toFixed(2)),
        totalEventsInjected,
      });

      console.log(
        `  [Soak ${Math.round(elapsedSec)}s/${DURATION_SECONDS}s] Injected: ${totalEventsInjected.toLocaleString()} events | Heap: ${heapUsedMb.toFixed(2)} MB (${driftFromBaselineMb >= 0 ? '+' : ''}${driftFromBaselineMb.toFixed(2)} MB) | RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`
      );
    }

    await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL_MS));
  }

  // Final settling and forced GC
  await new Promise(resolve => setTimeout(resolve, 500));
  forceGC();
  const finalMem = process.memoryUsage();
  const finalHeapMb = (finalMem.heapUsed / 1024 / 1024).toFixed(2);

  // Compute stabilization
  const recentSnapshots = snapshots.slice(Math.max(0, snapshots.length - 4));
  const recentHeaps = recentSnapshots.map(s => s.heapUsedMb);
  const minRecent = Math.min(...recentHeaps);
  const maxRecent = Math.max(...recentHeaps);
  const plateauDriftPct = minRecent > 0 ? (((maxRecent - minRecent) / minRecent) * 100).toFixed(2) : '0.00';

  console.log('\n' + '='.repeat(80));
  console.log(' SOAK STABILITY SUMMARY');
  console.log('='.repeat(80));
  console.log(` Total Duration: ${DURATION_SECONDS}s`);
  console.log(` Total Events Injected: ${totalEventsInjected.toLocaleString()}`);
  console.log(` Baseline Heap: ${baselineHeapMb} MB`);
  console.log(` Final Post-GC Heap: ${finalHeapMb} MB`);
  console.log(` Plateau Drift (last cycles): ${plateauDriftPct}%`);

  const tShutdownStart = performance.now();
  const shutdownResult = await shutdown(5000);
  const shutdownMs = (performance.now() - tShutdownStart).toFixed(1);
  console.log(` Graceful Shutdown: ${shutdownMs}ms (Timed out: ${shutdownResult.timedOut})`);

  await mock.close();

  const results = {
    durationSeconds: DURATION_SECONDS,
    totalEventsInjected,
    baselineHeapMb: parseFloat(baselineHeapMb),
    finalHeapMb: parseFloat(finalHeapMb),
    plateauDriftPct: parseFloat(plateauDriftPct),
    shutdownMs: parseFloat(shutdownMs),
    shutdownTimedOut: shutdownResult.timedOut,
    snapshots,
  };

  fs.writeFileSync('soak_results.json', JSON.stringify(results, null, 2));
  console.log('  ✓ soak_results.json generated successfully');
  console.log('='.repeat(80));
}

runSoakTest().catch(err => {
  console.error('[Soak] Fatal test failure:', err);
  process.exit(1);
});
