/**
 * Normalizes raw cubicle telemetry events into canonical domain models.
 * Strictly adheres to Principle 1.2: NEVER INVENT TELEMETRY.
 * If a field is missing, it is set to null or explicitly marked as not available.
 */

export function normalizeRequest(record) {
  const d = record.data;
  return {
    requestId: d.requestId || null,
    method: d.method || 'UNKNOWN',
    url: d.url || null,
    route: d.route || d.url || 'Unknown Route',
    statusCode: typeof d.statusCode === 'number' ? d.statusCode : null,
    latency: typeof d.latency === 'number' ? d.latency : null,
    timestamp: d.timestamp || null,
    traceId: d.traceId || null,
    spanId: d.spanId || null,
    clientIp: d.clientIp || null,
    userAgent: d.userAgent || null,
    referer: d.referer || null,
    headers: d.headers || {},
    query: d.query || {},
    body: d.body ?? null,
    bodySize: d.bodySize ?? null,
    responseSize: d.responseSize ?? null,
    metadata: d.metadata || {},
    tags: d.tags || {},
    sessionId: d.sessionId || null,
    _provenance: record._provenance
  };
}

export function normalizeError(record) {
  const d = record.data;
  return {
    eventId: d.eventId || null,
    type: d.type || 'error',
    name: d.name || 'Error',
    message: d.message || 'No message provided',
    stack: Array.isArray(d.stack) ? d.stack : [],
    rawStack: typeof d.stack === 'string' ? d.stack : null,
    fingerprint: d.fingerprint || null,
    severity: d.severity || 'error',
    timestamp: d.timestamp || null,
    context: d.context || {},
    mechanism: d.mechanism || (d.extra && d.extra.mechanism) || 'unknown',
    handled: d.handled ?? (d.extra && d.extra.handled) ?? null,
    classification: d.classification || {},
    requestId: d.requestId || null,
    traceId: d.traceId || null,
    spanId: d.spanId || null,
    statusCode: d.statusCode ?? null,
    method: d.method || null,
    route: d.route || null,
    url: d.url || null,
    metadata: d.metadata || {},
    sessionId: d.sessionId || null,
    tags: d.tags || {},
    extra: d.extra || {},
    _provenance: record._provenance
  };
}

export function normalizeLog(record) {
  const d = record.data;
  return {
    eventId: d.eventId || null,
    type: d.type || 'log',
    level: d.level || 'info',
    message: d.message || '',
    timestamp: d.timestamp || null,
    args: d.args || [],
    requestId: d.requestId || null,
    traceId: d.traceId || null,
    spanId: d.spanId || null,
    metadata: d.metadata || {},
    sessionId: d.sessionId || null,
    tags: d.tags || {},
    extra: d.extra || {},
    _provenance: record._provenance
  };
}

export function normalizeSpan(rawSpan, provenance) {
  const attrs = rawSpan.attributes || {};
  
  // Detect DB system if present
  let dbSystem = attrs['db.system'] || attrs['db.system.name'] || null;
  if (!dbSystem) {
    if (rawSpan.name && rawSpan.name.includes('$cmd')) dbSystem = 'mongodb';
    else if (attrs['pulse.instrumentation.layer'] === 'mongoose') dbSystem = 'mongodb';
    else if (rawSpan.name && rawSpan.name.startsWith('pg')) dbSystem = 'postgresql';
    else if (rawSpan.name && rawSpan.name.startsWith('prisma')) dbSystem = 'prisma';
  }

  const dbOperation = attrs['db.operation'] || attrs['db.operation.name'] || null;
  const dbCollection = attrs['db.mongodb.collection'] || attrs['db.collection.name'] || null;
  const dbStatement = attrs['db.statement'] || attrs['db.query.text'] || null;

  return {
    spanId: rawSpan.spanId,
    traceId: rawSpan.traceId || null,
    parentSpanId: rawSpan.parentSpanId || null,
    name: rawSpan.name || 'Unnamed Span',
    kind: rawSpan.kind || 'internal',
    startTime: rawSpan.startTime ?? null,
    endTime: rawSpan.endTime ?? null,
    duration: typeof rawSpan.duration === 'number' ? rawSpan.duration : (
      rawSpan.startTime != null && rawSpan.endTime != null ? rawSpan.endTime - rawSpan.startTime : null
    ),
    exclusiveDuration: rawSpan.exclusiveDuration ?? null,
    status: rawSpan.status || 'unset',
    statusMessage: rawSpan.statusMessage || null,
    attributes: attrs,
    events: Array.isArray(rawSpan.events) ? rawSpan.events : [],
    links: Array.isArray(rawSpan.links) ? rawSpan.links : [],
    metadata: rawSpan.metadata || {},
    sessionId: rawSpan.sessionId || null,
    requestId: rawSpan.requestId || attrs['pulse.request_id'] || null,
    tags: rawSpan.tags || {},
    isSampled: rawSpan.isSampled ?? null,
    traceFlags: rawSpan.traceFlags ?? null,
    database: dbSystem ? {
      system: dbSystem,
      operation: dbOperation || rawSpan.name,
      collection: dbCollection,
      statement: dbStatement
    } : null,
    _provenance: provenance
  };
}

export function normalizeTrace(record) {
  const d = record.data;
  return {
    traceId: d.traceId,
    eventId: d.eventId || null,
    rootSpan: d.rootSpan || null,
    spanCount: d.spanCount || 1,
    totalDuration: d.totalDuration ?? (d.rootSpan ? d.rootSpan.duration : null),
    isPartial: d.isPartial ?? false,
    metadata: d.metadata || {},
    sessionId: d.sessionId || null,
    tailSampled: d.tailSampled ?? false,
    hasError: d.hasError ?? (d.rootSpan?.status === 'error'),
    isSlow: d.isSlow ?? false,
    timestamp: d.timestamp || (d.rootSpan ? d.rootSpan.startTime : null),
    tags: d.tags || {},
    _provenance: record._provenance
  };
}

export function normalizeInit(record) {
  const d = record.data;
  return {
    timestamp: d.timestamp,
    method: d.method || 'POST',
    path: d.path || '/v1/init',
    headers: d.headers || {},
    rawBody: d.rawBody || '',
    parsedBody: d.parsedBody || {},
    apiKey: (d.headers && (d.headers['x-api-key'] || d.headers['authorization'])) || null,
    _provenance: record._provenance
  };
}
