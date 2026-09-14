import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCubicleData } from './loader.js';
import { correlateTelemetry } from './correlator.js';
import { runDiagnostics } from './diagnostics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function cleanRequestDTO(r) {
  return {
    requestId: r.requestId,
    method: r.method,
    url: r.url,
    route: r.route,
    statusCode: r.statusCode,
    latency: r.latency,
    timestamp: r.timestamp,
    traceId: r.traceId,
    spanId: r.spanId,
    clientIp: r.clientIp,
    userAgent: r.userAgent,
    referer: r.referer,
    headers: r.headers,
    query: r.query,
    body: r.body,
    bodySize: r.bodySize,
    responseSize: r.responseSize,
    metadata: r.metadata,
    tags: r.tags,
    sessionId: r.sessionId,
    errorCount: r.correlatedErrors ? r.correlatedErrors.length : 0,
    logCount: r.correlatedLogs ? r.correlatedLogs.length : 0,
    traceSummary: r.correlatedTrace ? {
      traceId: r.correlatedTrace.traceId,
      duration: r.correlatedTrace.totalDuration,
      spanCount: r.correlatedTrace.spanCount,
      hasError: r.correlatedTrace.hasError
    } : null,
    _provenance: r._provenance
  };
}

function cleanErrorDTO(e) {
  return {
    eventId: e.eventId,
    type: e.type,
    name: e.name,
    message: e.message,
    stack: e.stack,
    rawStack: e.rawStack,
    fingerprint: e.fingerprint,
    severity: e.severity,
    timestamp: e.timestamp,
    context: e.context,
    mechanism: e.mechanism,
    handled: e.handled,
    classification: e.classification,
    requestId: e.requestId,
    traceId: e.traceId,
    spanId: e.spanId,
    statusCode: e.statusCode,
    method: e.method,
    route: e.route,
    url: e.url,
    metadata: e.metadata,
    sessionId: e.sessionId,
    tags: e.tags,
    extra: e.extra,
    correlatedSpanName: e.correlatedSpan?.name || null,
    _provenance: e._provenance
  };
}

function cleanLogDTO(l) {
  return {
    eventId: l.eventId,
    type: l.type,
    level: l.level,
    message: l.message,
    timestamp: l.timestamp,
    args: l.args,
    requestId: l.requestId,
    traceId: l.traceId,
    spanId: l.spanId,
    metadata: l.metadata,
    sessionId: l.sessionId,
    tags: l.tags,
    extra: l.extra,
    _provenance: l._provenance
  };
}

function cleanSpanDTO(s) {
  return {
    spanId: s.spanId,
    traceId: s.traceId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    startTime: s.startTime,
    endTime: s.endTime,
    duration: s.duration,
    exclusiveDuration: s.exclusiveDuration,
    status: s.status,
    statusMessage: s.statusMessage,
    attributes: s.attributes,
    events: s.events,
    links: s.links,
    metadata: s.metadata,
    sessionId: s.sessionId,
    requestId: s.requestId,
    tags: s.tags,
    isSampled: s.isSampled,
    traceFlags: s.traceFlags,
    database: s.database,
    errorCount: s.errors ? s.errors.length : 0,
    logCount: s.logs ? s.logs.length : 0,
    _provenance: s._provenance
  };
}

function cleanWaterfallNode(node) {
  if (!node) return null;
  return {
    spanId: node.spanId,
    originalMissingId: node.originalMissingId || null,
    parentSpanId: node.parentSpanId || null,
    name: node.name,
    kind: node.kind,
    status: node.status,
    statusMessage: node.statusMessage,
    startTime: node.startTime,
    endTime: node.endTime,
    duration: node.duration,
    exclusiveDuration: node.exclusiveDuration,
    offsetMs: node.offsetMs,
    offsetPercent: node.offsetPercent,
    durationPercent: node.durationPercent,
    attributes: node.attributes,
    events: node.events,
    links: node.links,
    isVirtualMissingParent: node.isVirtualMissingParent || false,
    isMissingParent: node.isMissingParent || false,
    isOrphan: node.isOrphan || false,
    children: (node.children || []).map(cleanWaterfallNode)
  };
}

export function buildPlatformData(options = {}) {
  const rootDir = path.resolve(__dirname, '../../..');
  const cubicleDir = options.cubicleDir || path.join(rootDir, 'sdk-node/cubicle');
  const outputDir = options.outputDir || path.resolve(__dirname, '../ui/data');

  console.log(`[Build] Loading telemetry from: ${cubicleDir}`);
  const startTime = Date.now();
  const loaded = loadCubicleData(cubicleDir);
  console.log(`[Build] Ingested ${loaded.metadata.counts.totalFiles} files in ${Date.now() - startTime}ms`);

  console.log(`[Build] Correlating telemetry graph...`);
  const corrStart = Date.now();
  const model = correlateTelemetry(loaded);
  console.log(`[Build] Correlated ${model.traces.length} traces, ${model.spans.length} unique spans, ${model.requests.length} requests in ${Date.now() - corrStart}ms`);

  console.log(`[Build] Running forensic diagnostics...`);
  const diagStart = Date.now();
  const diagnostics = runDiagnostics(model, loaded);
  console.log(`[Build] Diagnostics completed in ${Date.now() - diagStart}ms`);

  // Ensure output directories exist
  fs.mkdirSync(outputDir, { recursive: true });
  const tracesDetailDir = path.join(outputDir, 'traces');
  fs.mkdirSync(tracesDetailDir, { recursive: true });

  // 1. Summary Overview Data
  const requestLatencies = model.requests.map(r => r.latency).filter(l => typeof l === 'number').sort((a, b) => a - b);
  const reqSum = requestLatencies.reduce((a, b) => a + b, 0);
  const avgReqLatency = requestLatencies.length > 0 ? reqSum / requestLatencies.length : 0;
  const p50Req = requestLatencies.length > 0 ? requestLatencies[Math.floor(requestLatencies.length * 0.5)] : 0;
  const p95Req = requestLatencies.length > 0 ? requestLatencies[Math.floor(requestLatencies.length * 0.95)] : 0;
  const p99Req = requestLatencies.length > 0 ? requestLatencies[Math.floor(requestLatencies.length * 0.99)] : 0;

  const errorRequests = model.requests.filter(r => r.statusCode >= 400 || (r.correlatedErrors && r.correlatedErrors.length > 0));
  const errorRate = model.requests.length > 0 ? (errorRequests.length / model.requests.length) * 100 : 0;

  // Slowest requests
  const slowestRequests = [...model.requests].sort((a, b) => (b.latency || 0) - (a.latency || 0)).slice(0, 5);
  // Slowest traces
  const slowestTraces = [...model.traces].sort((a, b) => (b.totalDuration || 0) - (a.totalDuration || 0)).slice(0, 10).map(t => ({
    traceId: t.traceId,
    name: t.rootSpan?.name || 'Trace',
    duration: t.totalDuration,
    spanCount: t.spanCount,
    hasError: t.hasError,
    timestamp: t.timestamp
  }));

  const dbBySystem = {};
  for (const db of model.databases) {
    dbBySystem[db.system] = (dbBySystem[db.system] || 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    metrics: {
      totalRequests: model.requests.length,
      totalTraces: model.traces.length,
      totalSpans: model.spans.length,
      totalErrors: model.errors.length,
      totalLogs: model.logs.length,
      totalDbOperations: model.databases.length,
      totalInitEvents: model.inits.length,
      totalRawBatches: loaded.metadata.counts.raw_batches,
      totalRawFiles: loaded.metadata.counts.totalFiles,
      errorRatePercent: Number(errorRate.toFixed(1)),
      latency: {
        avgMs: Number(avgReqLatency.toFixed(2)),
        p50Ms: p50Req,
        p95Ms: p95Req,
        p99Ms: p99Req
      }
    },
    slowestRequests: slowestRequests.map(r => ({
      requestId: r.requestId,
      method: r.method,
      url: r.url,
      statusCode: r.statusCode,
      latency: r.latency,
      traceId: r.traceId
    })),
    slowestTraces,
    dbBySystem,
    services: model.services,
    metadataCounts: loaded.metadata.counts
  };

  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // 2. Requests Data
  const cleanRequests = model.requests.map(cleanRequestDTO);
  fs.writeFileSync(path.join(outputDir, 'requests.json'), JSON.stringify(cleanRequests, null, 2));

  // 3. Errors Data
  const cleanErrors = model.errors.map(cleanErrorDTO);
  const cleanErrorGroups = model.errorGroups.map(g => ({
    fingerprint: g.fingerprint,
    name: g.name,
    message: g.message,
    severity: g.severity,
    mechanism: g.mechanism,
    handled: g.handled,
    count: g.occurrences.length,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    stack: g.stack,
    occurrences: g.occurrences.map(cleanErrorDTO)
  }));
  fs.writeFileSync(path.join(outputDir, 'errors.json'), JSON.stringify({
    errors: cleanErrors,
    errorGroups: cleanErrorGroups
  }, null, 2));

  // 4. Logs Data
  const cleanLogs = model.logs.map(cleanLogDTO);
  fs.writeFileSync(path.join(outputDir, 'logs.json'), JSON.stringify(cleanLogs, null, 2));

  // 5. Databases Data
  fs.writeFileSync(path.join(outputDir, 'databases.json'), JSON.stringify({
    operations: model.databases,
    bySystem: dbBySystem
  }, null, 2));

  // 6. Services Data
  fs.writeFileSync(path.join(outputDir, 'services.json'), JSON.stringify(model.services, null, 2));

  // 7. Diagnostics Data
  fs.writeFileSync(path.join(outputDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));

  // 8. Traces Index
  const tracesIndex = model.traces.map(t => ({
    traceId: t.traceId,
    name: t.rootSpan?.name || 'Trace',
    kind: t.rootSpan?.kind || 'unknown',
    duration: t.totalDuration,
    spanCount: t.spanCount || (t.spans ? t.spans.length : 1),
    hasError: t.hasError,
    timestamp: t.timestamp,
    service: t.metadata?.applicationName || 'cubicle-backend',
    requestId: t.request?.requestId || t.tags?.['pulse.request_id'] || null,
    method: t.request?.method || null,
    route: t.request?.route || null
  }));
  fs.writeFileSync(path.join(outputDir, 'traces_index.json'), JSON.stringify(tracesIndex, null, 2));

  // 9. Full Trace Detail Files
  console.log(`[Build] Writing individual trace detail payloads...`);
  for (const t of model.traces) {
    const traceDetail = {
      traceId: t.traceId,
      eventId: t.eventId,
      rootSpan: t.rootSpan,
      spanCount: t.spanCount,
      totalDuration: t.totalDuration,
      isPartial: t.isPartial,
      metadata: t.metadata,
      sessionId: t.sessionId,
      tailSampled: t.tailSampled,
      hasError: t.hasError,
      isSlow: t.isSlow,
      timestamp: t.timestamp,
      tags: t.tags,
      request: t.request ? cleanRequestDTO(t.request) : null,
      errors: (t.errors || []).map(cleanErrorDTO),
      logs: (t.logs || []).map(cleanLogDTO),
      waterfall: {
        traceId: t.waterfall.traceId,
        roots: (t.waterfall.roots || []).map(cleanWaterfallNode),
        displayList: (t.waterfall.displayList || []).map(node => ({
          ...cleanWaterfallNode(node),
          displayDepth: node.displayDepth,
          rowId: node.rowId,
          hasChildren: node.hasChildren
        })),
        traceStartTime: t.waterfall.traceStartTime,
        traceEndTime: t.waterfall.traceEndTime,
        totalDuration: t.waterfall.totalDuration,
        missingParents: t.waterfall.missingParents,
        missingParentNodesCount: t.waterfall.missingParentNodesCount,
        spanCount: t.waterfall.spanCount
      },
      spans: (t.spans || []).map(cleanSpanDTO),
      _provenance: t._provenance
    };
    fs.writeFileSync(path.join(tracesDetailDir, `${t.traceId}.json`), JSON.stringify(traceDetail, null, 2));
  }

  // 10. Raw Events Manifest
  console.log(`[Build] Generating raw events manifest...`);
  const rawEventsManifest = [];
  for (const cat of ['init', 'requests', 'errors', 'logs', 'spans', 'traces', 'raw_batches']) {
    for (const item of loaded[cat]) {
      rawEventsManifest.push({
        category: cat,
        filename: item._provenance.filename,
        relativePath: item._provenance.relativePath,
        sizeBytes: item._provenance.sizeBytes,
        mtime: item._provenance.mtime,
        eventId: item.data?.eventId || null,
        traceId: item.data?.traceId || null,
        spanId: item.data?.spanId || null,
        requestId: item.data?.requestId || null,
        type: item.data?.type || cat,
        name: item.data?.name || item.data?.method || null,
        dataSlice: JSON.stringify(item.data).slice(0, 300)
      });
    }
  }
  fs.writeFileSync(path.join(outputDir, 'raw_events_manifest.json'), JSON.stringify(rawEventsManifest, null, 2));

  console.log(`[Build] Build complete! Output written to: ${outputDir}`);
  return {
    summary,
    diagnostics,
    totalFilesGenerated: 9 + model.traces.length
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildPlatformData();
}
