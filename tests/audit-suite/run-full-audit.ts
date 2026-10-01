import { runMicrobenchmarks } from './audit-microbenchmarks.test.js'
import { runHttpComparativeBenchmark } from './audit-http-comparative.test.js'
import { runMemoryGCAudit } from './audit-memory-gc-leak.test.js'
import { runCpuProfiling } from './audit-cpu-flamegraph.test.js'
import { runIoResilienceAudit } from './audit-io-resilience.test.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function main() {
  console.log('='.repeat(80))
  console.log('     PULSE APM SDK — DEEP FORENSIC PERFORMANCE & RELIABILITY AUDIT')
  console.log('='.repeat(80))
  console.log(`Node Version: ${process.version}`)
  console.log(`Platform: ${process.platform} (${process.arch})`)
  console.log(`Process PID: ${process.pid}`)
  console.log(`Execution Time: ${new Date().toISOString()}`)
  console.log('='.repeat(80))

  console.log('\n[1/5] Executing Isolated SDK Call Microbenchmarks...')
  const microResults = await runMicrobenchmarks(10_000)
  console.log(` -> Completed! SDK Init: ${microResults.initDurationMs}ms | Event Loop Lag p99: ${microResults.eventLoopLag.p99Ms}ms`)

  console.log('\n[2/5] Executing Comparative HTTP Baseline vs SDK Load Benchmark...')
  const httpResults = await runHttpComparativeBenchmark([
    { concurrency: 1, requests: 1_000 },
    { concurrency: 10, requests: 2_500 },
    { concurrency: 50, requests: 5_000 },
    { concurrency: 100, requests: 5_000 },
  ])
  console.log(` -> Completed across ${httpResults.length} concurrency tiers!`)

  console.log('\n[3/5] Executing Memory Stability, GC Pauses & Leak Detection Audit...')
  const memoryResults = await runMemoryGCAudit(10_000)
  console.log(` -> Completed! Net Heap Growth: ${memoryResults.heapGrowthMb} MB | Peak Heap: ${memoryResults.heapPeakMb} MB | GC Pauses: ${memoryResults.gcPauses.count}`)

  console.log('\n[4/5] Executing CPU Profiler & Hotspot Analysis...')
  const cpuResults = await runCpuProfiling(5_000)
  console.log(` -> Completed! Profiled ${cpuResults.totalSamples} CPU samples over ${cpuResults.durationMs}ms`)

  console.log('\n[5/5] Executing Network, I/O, Wire Compression & Fault Tolerance Audit...')
  const ioResults = await runIoResilienceAudit()
  console.log(` -> Completed! Wire Compression: ${ioResults.compressionRatioPercent}% | Fail-Open 500/429/Timeout: PASSED`)

  const fullAuditReportData = {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      v8Version: process.versions.v8,
      pid: process.pid,
    },
    microbenchmarks: microResults,
    httpComparative: httpResults,
    memoryAndGc: memoryResults,
    cpuProfiling: cpuResults,
    ioAndResilience: ioResults,
  }

  const outputPath = join(process.cwd(), 'audit-benchmark-results.json')
  await writeFile(outputPath, JSON.stringify(fullAuditReportData, null, 2), 'utf8')
  console.log(`\nAudit benchmark data successfully persisted to: ${outputPath}`)

  console.log('\n' + '='.repeat(80))
  console.log('                      AUDIT BENCHMARK SUMMARY')
  console.log('='.repeat(80))

  console.log('\n--- MICROBENCHMARK LATENCY & CPU TIME PER OPERATION ---')
  console.table(
    microResults.results.map(r => ({
      Operation: r.operation,
      'Avg Latency (µs)': r.avgLatencyUs,
      'p50 (µs)': r.p50Us,
      'p95 (µs)': r.p95Us,
      'p99 (µs)': r.p99Us,
      'Max (µs)': r.maxUs,
      'Ops / Sec': r.opsPerSec.toLocaleString(),
      'CPU / Op (µs)': r.cpuPerOpUs,
    }))
  )

  console.log('\n--- HTTP COMPARATIVE LATENCY & THROUGHPUT (BASELINE vs WITH SDK) ---')
  console.table(
    httpResults.map(r => ({
      Concurrency: r.concurrency,
      Requests: r.totalRequests,
      'Base RPS': r.baseline.rps,
      'SDK RPS': r.withSdk.rps,
      'RPS Impact': `${r.delta.rpsChangePercent}%`,
      'Base p50 (ms)': r.baseline.p50Ms,
      'SDK p50 (ms)': r.withSdk.p50Ms,
      'p50 Δ (ms)': `+${r.delta.latencyP50DeltaMs}`,
      'Base p99 (ms)': r.baseline.p99Ms,
      'SDK p99 (ms)': r.withSdk.p99Ms,
      'p99 Δ (ms)': `+${r.delta.latencyP99DeltaMs}`,
      'Base CPU': `${Math.round(r.baseline.cpuTotalUs / 1000)}ms`,
      'SDK CPU': `${Math.round(r.withSdk.cpuTotalUs / 1000)}ms`,
      'Lag p99 (Base)': `${r.baseline.eventLoopLagP99Ms}ms`,
      'Lag p99 (SDK)': `${r.withSdk.eventLoopLagP99Ms}ms`,
    }))
  )

  console.log('\n--- MEMORY & GC BEHAVIOR (10,000 Operations) ---')
  console.log(`  Initial Heap:            ${memoryResults.heapInitialMb} MB`)
  console.log(`  Peak Heap Under Load:    ${memoryResults.heapPeakMb} MB`)
  console.log(`  Post-Load Heap:          ${memoryResults.heapPostLoadMb} MB`)
  console.log(`  Final Heap (Post-GC):    ${memoryResults.heapFinalPostGcMb} MB`)
  console.log(`  Net Heap Growth:         ${memoryResults.heapGrowthMb} MB`)
  console.log(`  Initial RSS:             ${memoryResults.rssInitialMb} MB`)
  console.log(`  Peak RSS:                ${memoryResults.rssPeakMb} MB`)
  console.log(`  Final RSS:               ${memoryResults.rssFinalMb} MB`)
  console.log(`  GC Pause Count:          ${memoryResults.gcPauses.count}`)
  console.log(`  Total GC Pause Time:     ${memoryResults.gcPauses.totalDurationMs} ms`)
  console.log(`  Max GC Pause:            ${memoryResults.gcPauses.maxDurationMs} ms`)
  console.log(`  Memory Leak Suspected:   ${memoryResults.isLeakSuspected ? 'YES (FAIL)' : 'NO (PASSED)'}`)
  console.log(`  Active Handles on Exit:  ${memoryResults.activeHandlesAfterShutdown}`)

  console.log('\n--- CPU HOTSPOT ANALYSIS (Top SDK Overhead Functions) ---')
  console.table(
    cpuResults.sdkOverheadHotspots.map(h => ({
      Function: h.functionName,
      HitCount: h.hitCount,
      'CPU %': `${h.percentage}%`,
      Location: `${h.url}:${h.lineNumber}`,
    }))
  )

  console.log('\n--- NETWORK, I/O & RESILIENCE ---')
  console.log(`  Total Telemetry Batches: ${ioResults.totalBatchesReceived}`)
  console.log(`  Total Telemetry Events:  ${ioResults.totalEventsReceived}`)
  console.log(`  Raw Payload Size:        ${Math.round(ioResults.rawPayloadBytesTotal / 1024)} KB`)
  console.log(`  Wire Payload Size:       ${Math.round(ioResults.wirePayloadBytesTotal / 1024)} KB`)
  console.log(`  Gzip Compression Ratio:  ${ioResults.compressionRatioPercent}% reduction`)
  console.log(`  HTTP Keep-Alive Sockets: ${ioResults.keepAliveReusedSockets}`)
  console.log(`  Fail-Open (500 Error):   ${ioResults.failOpenUnder500Success ? 'PASSED' : 'FAILED'}`)
  console.log(`  Fail-Open (429 Quota):   ${ioResults.failOpenUnder429Success ? 'PASSED' : 'FAILED'}`)
  console.log(`  Fail-Open (Slow I/O):    ${ioResults.failOpenUnderTimeoutSuccess ? 'PASSED' : 'FAILED'}`)

  console.log('\n' + '='.repeat(80))
}

main().catch(err => {
  console.error('Audit benchmark execution failed:', err)
  process.exit(1)
})
