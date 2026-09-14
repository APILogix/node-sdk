import { normalizeRequest, normalizeError, normalizeLog, normalizeSpan, normalizeTrace, normalizeInit } from './normalizer.js';
import { buildTraceWaterfall } from './waterfall-builder.js';

/**
 * Builds the correlated, interconnected domain model from raw loaded cubicle data.
 */
export function correlateTelemetry(loadedData) {
  // 1. Normalize all inputs
  const rawRequests = loadedData.requests.map(r => normalizeRequest(r));
  const rawErrors = loadedData.errors.map(e => normalizeError(e));
  const rawLogs = loadedData.logs.map(l => normalizeLog(l));
  const rawInits = loadedData.init.map(i => normalizeInit(i));
  const rawTraces = loadedData.traces.map(t => normalizeTrace(t));

  // 2. Build complete span index (from cubicle/spans AND embedded trace rootSpan/children)
  const spanIndex = new Map(); // spanId -> normalizedSpan

  // Ingest from cubicle/spans
  for (const sRecord of loadedData.spans) {
    const s = normalizeSpan(sRecord.data, sRecord._provenance);
    spanIndex.set(s.spanId, s);
  }

  // Ingest any spans discovered in trace rootSpan/children trees that weren't in cubicle/spans
  function traverseNestedSpans(node, traceMeta, provenance, parentId = null) {
    if (!node || !node.spanId) return;
    if (!spanIndex.has(node.spanId)) {
      const s = normalizeSpan({
        ...node,
        traceId: node.traceId || traceMeta.traceId,
        parentSpanId: node.parentSpanId || parentId
      }, {
        category: 'embedded_in_trace',
        filename: provenance.filename,
        relativePath: provenance.relativePath,
        sizeBytes: provenance.sizeBytes,
        mtime: provenance.mtime
      });
      spanIndex.set(node.spanId, s);
    }
    for (const child of (node.children || [])) {
      traverseNestedSpans(child, traceMeta, provenance, node.spanId);
    }
  }

  for (const tRecord of loadedData.traces) {
    if (tRecord.data.rootSpan) {
      traverseNestedSpans(tRecord.data.rootSpan, tRecord.data, tRecord._provenance, null);
    }
  }

  // 3. Group spans by traceId
  const spansByTraceId = new Map();
  for (const span of spanIndex.values()) {
    if (span.traceId) {
      if (!spansByTraceId.has(span.traceId)) {
        spansByTraceId.set(span.traceId, []);
      }
      spansByTraceId.get(span.traceId).push(span);
    }
  }

  // 4. Index traces by traceId (deduplicating duplicate batch submissions)
  const traceIndex = new Map();
  const duplicateTraces = [];

  for (const t of rawTraces) {
    if (traceIndex.has(t.traceId)) {
      duplicateTraces.push({
        traceId: t.traceId,
        firstProvenance: traceIndex.get(t.traceId)._provenance,
        duplicateProvenance: t._provenance
      });
      // Merge metadata if needed, keep primary
    } else {
      traceIndex.set(t.traceId, t);
    }
  }

  // Ensure any traceId found in spans has a trace object even if trace file was missing
  for (const [traceId, spans] of spansByTraceId.entries()) {
    if (!traceIndex.has(traceId)) {
      const earliestStart = Math.min(...spans.map(s => s.startTime || Infinity));
      const latestEnd = Math.max(...spans.map(s => s.endTime || 0));
      traceIndex.set(traceId, {
        traceId,
        eventId: null,
        rootSpan: spans.find(s => !s.parentSpanId) || spans[0] || null,
        spanCount: spans.length,
        totalDuration: Math.max(0, latestEnd - earliestStart),
        isPartial: true,
        metadata: spans[0]?.metadata || {},
        sessionId: spans[0]?.sessionId || null,
        tailSampled: false,
        hasError: spans.some(s => s.status === 'error'),
        isSlow: false,
        timestamp: earliestStart !== Infinity ? earliestStart : null,
        tags: spans[0]?.tags || {},
        _provenance: {
          category: 'synthesized_from_spans',
          filename: 'none',
          relativePath: 'none',
          sizeBytes: 0,
          mtime: new Date().toISOString()
        }
      });
    }
  }

  // 5. Correlate Requests
  const requestIndex = new Map();
  for (const req of rawRequests) {
    req.correlatedTrace = req.traceId ? (traceIndex.get(req.traceId) || null) : null;
    req.correlatedSpan = req.spanId ? (spanIndex.get(req.spanId) || null) : null;
    req.correlatedErrors = [];
    req.correlatedLogs = [];
    if (req.requestId) {
      requestIndex.set(req.requestId, req);
    }
  }

  // 6. Correlate Errors
  const errorIndex = new Map();
  const errorGroups = new Map(); // fingerprint -> group

  for (const err of rawErrors) {
    err.correlatedTrace = err.traceId ? (traceIndex.get(err.traceId) || null) : null;
    err.correlatedSpan = err.spanId ? (spanIndex.get(err.spanId) || null) : null;
    err.correlatedRequest = err.requestId ? (requestIndex.get(err.requestId) || null) : null;

    if (err.eventId) errorIndex.set(err.eventId, err);

    // Grouping
    const groupKey = err.fingerprint || `${err.name}::${err.message.slice(0, 80)}`;
    if (!errorGroups.has(groupKey)) {
      errorGroups.set(groupKey, {
        fingerprint: groupKey,
        name: err.name,
        message: err.message,
        severity: err.severity,
        mechanism: err.mechanism,
        handled: err.handled,
        occurrences: [],
        firstSeen: err.timestamp,
        lastSeen: err.timestamp,
        stack: err.stack
      });
    }
    const group = errorGroups.get(groupKey);
    group.occurrences.push(err);
    if (err.timestamp && (!group.firstSeen || err.timestamp < group.firstSeen)) group.firstSeen = err.timestamp;
    if (err.timestamp && (!group.lastSeen || err.timestamp > group.lastSeen)) group.lastSeen = err.timestamp;

    // Attach to correlated trace and span
    if (err.correlatedTrace) {
      if (!err.correlatedTrace.errors) err.correlatedTrace.errors = [];
      err.correlatedTrace.errors.push(err);
      err.correlatedTrace.hasError = true;
    }
    if (err.correlatedSpan) {
      if (!err.correlatedSpan.errors) err.correlatedSpan.errors = [];
      err.correlatedSpan.errors.push(err);
    }
    if (err.correlatedRequest) {
      err.correlatedRequest.correlatedErrors.push(err);
    }
  }

  // 7. Correlate Logs
  for (const log of rawLogs) {
    log.correlatedTrace = log.traceId ? (traceIndex.get(log.traceId) || null) : null;
    log.correlatedSpan = log.spanId ? (spanIndex.get(log.spanId) || null) : null;
    log.correlatedRequest = log.requestId ? (requestIndex.get(log.requestId) || null) : null;

    if (log.correlatedTrace) {
      if (!log.correlatedTrace.logs) log.correlatedTrace.logs = [];
      log.correlatedTrace.logs.push(log);
    }
    if (log.correlatedSpan) {
      if (!log.correlatedSpan.logs) log.correlatedSpan.logs = [];
      log.correlatedSpan.logs.push(log);
    }
    if (log.correlatedRequest) {
      log.correlatedRequest.correlatedLogs.push(log);
    }
  }

  // 8. Attach Requests to Traces
  for (const req of rawRequests) {
    if (req.traceId && traceIndex.has(req.traceId)) {
      traceIndex.get(req.traceId).request = req;
    }
  }

  // 9. Construct Waterfalls for each trace
  const waterfalls = new Map();
  for (const trace of traceIndex.values()) {
    const traceSpans = spansByTraceId.get(trace.traceId) || [];
    trace.spans = traceSpans;
    const wf = buildTraceWaterfall(trace, traceSpans);
    waterfalls.set(trace.traceId, wf);
    trace.waterfall = wf;
    trace.computedDuration = wf.totalDuration;
  }

  // 10. Extract Database Explorer Operations
  const dbOperations = [];
  for (const span of spanIndex.values()) {
    if (span.database) {
      dbOperations.push({
        spanId: span.spanId,
        traceId: span.traceId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        system: span.database.system,
        operation: span.database.operation,
        collection: span.database.collection,
        statement: span.database.statement,
        duration: span.duration,
        startTime: span.startTime,
        endTime: span.endTime,
        status: span.status,
        statusMessage: span.statusMessage,
        requestId: span.requestId,
        _provenance: span._provenance
      });
    }
  }

  // 11. Aggregate Service Performance
  const servicesMap = new Map();
  for (const span of spanIndex.values()) {
    const serviceName = span.metadata?.applicationName || span.attributes?.['service.name'] || 'cubicle-backend';
    if (!servicesMap.has(serviceName)) {
      servicesMap.set(serviceName, {
        name: serviceName,
        sdkName: span.metadata?.sdkName || '@pulse-apm/node',
        sdkVersion: span.metadata?.sdkVersion || '8.1.2',
        environment: span.metadata?.environment || 'production',
        release: span.metadata?.release || '8.0.0',
        projectId: span.metadata?.projectId || 'cubicle-project-001',
        traceCount: 0,
        spanCount: 0,
        requestCount: 0,
        errorCount: 0,
        dbCount: 0,
        durations: []
      });
    }
    const svc = servicesMap.get(serviceName);
    svc.spanCount++;
    if (span.duration != null) svc.durations.push(span.duration);
    if (span.status === 'error') svc.errorCount++;
    if (span.database) svc.dbCount++;
  }

  for (const req of rawRequests) {
    const svcName = req.metadata?.applicationName || 'cubicle-backend';
    if (servicesMap.has(svcName)) {
      servicesMap.get(svcName).requestCount++;
    }
  }

  const services = [];
  for (const svc of servicesMap.values()) {
    svc.traceCount = traceIndex.size;
    svc.durations.sort((a, b) => a - b);
    const count = svc.durations.length;
    const sum = svc.durations.reduce((a, b) => a + b, 0);
    svc.avgLatency = count > 0 ? sum / count : 0;
    svc.p50Latency = count > 0 ? svc.durations[Math.floor(count * 0.5)] : 0;
    svc.p95Latency = count > 0 ? svc.durations[Math.floor(count * 0.95)] : 0;
    svc.p99Latency = count > 0 ? svc.durations[Math.floor(count * 0.99)] : 0;
    services.push(svc);
  }

  return {
    requests: rawRequests,
    traces: Array.from(traceIndex.values()),
    spans: Array.from(spanIndex.values()),
    errors: rawErrors,
    errorGroups: Array.from(errorGroups.values()),
    logs: rawLogs,
    inits: rawInits,
    databases: dbOperations,
    services,
    waterfalls,
    duplicateTraces,
    indexes: {
      traceIndex,
      spanIndex,
      requestIndex,
      errorIndex
    }
  };
}
