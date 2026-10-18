import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const PORT = parseInt(process.env.PORT || '5055', 10);
const CUBICLE_DIR = path.resolve(process.env.CUBICLE_DIR || path.join(process.cwd(), 'cubicle'));

// Ensure cubicle event directories exist
const EVENT_DIRS = {
  request: 'requests',
  error: 'errors',
  trace: 'traces',
  span: 'spans',
  metric: 'metrics',
  log: 'logs',
  profile: 'profiles',
  cron_checkin: 'crons',
  cron: 'crons',
  message: 'messages',
  event: 'messages',
  init: 'init',
  raw_batches: 'raw_batches',
};

for (const dir of new Set(Object.values(EVENT_DIRS))) {
  fs.mkdirSync(path.join(CUBICLE_DIR, dir), { recursive: true });
}

function computeConfigHash(config) {
  const clone = structuredClone(config);
  if (clone.meta && clone.meta.configHash) {
    delete clone.meta.configHash;
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
  return `sha256:${hash}`;
}

function buildFullFeaturedConfig(baseUrl) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const routes = {
    traces: { url: `${normalizedBase}/api/v1/traces`, batchSize: 50, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'high' },
    requests: { url: `${normalizedBase}/api/v1/requests`, batchSize: 50, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'high' },
    spans: { url: `${normalizedBase}/api/v1/spans`, batchSize: 50, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'high' },
    errors: { url: `${normalizedBase}/api/v1/errors`, batchSize: 10, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'critical' },
    metrics: { url: `${normalizedBase}/api/v1/metrics`, batchSize: 100, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'normal' },
    logs: { url: `${normalizedBase}/api/v1/logs`, batchSize: 50, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'normal' },
    profiles: { url: `${normalizedBase}/api/v1/profiles`, batchSize: 5, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'low' },
    events: { url: `${normalizedBase}/api/v1/events`, batchSize: 20, flushIntervalMs: 50, timeoutMs: 5000, compression: 'gzip', priority: 'normal' },
    crons: { url: `${normalizedBase}/api/v1/crons`, batchSize: 1, flushIntervalMs: 0, timeoutMs: 5000, compression: 'none', priority: 'high' },
  };

  const config = {
    schemaVersion: 1,
    sdk: {
      projectId: 'cubicle-project-001',
      service: 'cubicle-service',
      environment: 'production',
      release: '8.0.0',
    },
    features: {
      tracing: true,
      requestCapture: true,
      errors: true,
      metrics: true,
      logging: true,
      profiling: true,
      crons: true,
      runtimeMetrics: true,
      eventLoopMonitoring: true,
      gcMonitoring: true,
    },
    sampling: {
      traces: 1.0,
      requests: 1.0,
      spans: 1.0,
      errors: 1.0,
      messages: 1.0,
      profiles: 1.0,
      metrics: 1.0,
      logs: 1.0,
      events: 1.0,
      crons: 1.0,
      routes: {},
    },
    instrumentation: {
      http: true,
      https: true,
      fetch: true,
      axios: true,
      fastify: { enabled: true, captureHooks: true, captureValidationErrors: true },
      express: { enabled: true },
      graphql: { enabled: true, captureResolvers: true },
      prisma: { enabled: true, captureQueries: true, captureParams: true },
      mongodb: true,
      redis: true,
      bullmq: true,
      pg: true,
      mysql2: true,
      eventEmitterPatch: true,
    },
    privacy: {
      capture: {
        headers: true,
        body: true,
        response: true,
        query: true,
        cookies: true,
      },
      scrubbing: {
        enabled: false,
        headers: [],
        fields: [],
      },
      piiDetection: {
        enabled: false,
        maskEmails: false,
        maskPhones: false,
        maskIPs: false,
      },
    },
    limits: {
      maxSpansPerTrace: 5000,
      maxSpanAttributes: 200,
      maxAttributeLength: 8192,
      maxPayloadSize: 4194304,
      maxQueueSize: 50000,
      maxMemoryMb: 1024,
      tenantGovernance: {
        enabled: false,
        maxTenantsTracked: 1000,
        quotaPerWindow: 10000,
        windowDurationMs: 60000,
        criticalReserve: 100,
      },
      persistenceGovernance: {
        maxPersistPerMinute: 50000,
        adaptive: true,
        budgetExceededLogIntervalMs: 60000,
      },
    },
    killswitches: {
      disableSDK: false,
      disableTracing: false,
      disableMetrics: false,
      disableTransport: false,
      disableProfiling: false,
      disableErrors: false,
      disableLogs: false,
    },
    entitlements: {
      customSpans: true,
      customMetrics: true,
      profiling: true,
      logging: true,
      crons: true,
      requestCapture: true,
      tracing: true,
      errors: true,
      metrics: true,
    },
    transport: {
      retry: { enabled: true, maxRetries: 3, backoff: 'exponential', baseDelayMs: 200 },
      queue: { overflowStrategy: 'drop_oldest', maxSize: 50000, criticalReserve: 100 },
      connections: { maxTotalConnections: 50, acquireTimeoutMs: 5000 },
      keepAlive: true,
      routes,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'pulse-mock-backend',
    },
  };

  config.meta.configHash = computeConfigHash(config);
  return config;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1:5000'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  // Read body buffer
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks);

  // Decompress body if needed
  const contentEncoding = (req.headers['content-encoding'] || '').toLowerCase();
  let decodedText = '';
  try {
    if (contentEncoding === 'gzip' && rawBody.length > 0) {
      decodedText = zlib.gunzipSync(rawBody).toString('utf8');
    } else if (contentEncoding === 'deflate' && rawBody.length > 0) {
      decodedText = zlib.inflateSync(rawBody).toString('utf8');
    } else {
      decodedText = rawBody.toString('utf8');
    }
  } catch (err) {
    decodedText = rawBody.toString('utf8');
  }

  let parsedBody = null;
  if (decodedText) {
    try {
      parsedBody = JSON.parse(decodedText);
    } catch {
      parsedBody = decodedText;
    }
  }

  console.log(`[Pulse Mock Backend] ${method} ${pathname} (${rawBody.length} raw bytes, ${decodedText.length} decoded bytes)`);

  // ─── Control Plane: /v1/init or /api/v1/init ──────────────────────────────
  if (pathname === '/v1/init' || pathname === '/api/v1/init') {
    const timestamp = Date.now();
    const initLog = {
      timestamp: new Date().toISOString(),
      method,
      path: pathname,
      headers: req.headers,
      rawBody: decodedText,
      parsedBody: parsedBody,
    };

    const initFile = path.join(CUBICLE_DIR, 'init', `init_request_${timestamp}.json`);
    fs.writeFileSync(initFile, JSON.stringify(initLog, null, 2), 'utf8');

    console.log(`\n================================================================`);
    console.log(`[Pulse Mock Backend] >>> RECEIVED SDK INIT REQUEST <<<`);
    console.log(`Saved init request record to: ${initFile}`);
    console.log(`Headers:`, JSON.stringify({
      'content-type': req.headers['content-type'],
      'x-pulse-internal': req.headers['x-pulse-internal'],
      'x-api-key': req.headers['x-api-key'],
    }, null, 2));
    console.log(`Body (exact payload sent by SDK):`, JSON.stringify(parsedBody));
    console.log(`================================================================\n`);

    const baseUrl = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
    const fullConfig = buildFullFeaturedConfig(baseUrl);

    const initResponse = {
      success: true,
      projectId: fullConfig.sdk.projectId,
      organizationId: 'org-cubicle-001',
      environmentId: 'env-cubicle-001',
      environment: fullConfig.sdk.environment,
      release: fullConfig.sdk.release,
      configRevision: 1,
      configHash: fullConfig.meta.configHash,
      config: fullConfig,
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'ETag': fullConfig.meta.configHash,
    });
    res.end(JSON.stringify(initResponse, null, 2));
    return;
  }

  // ─── Control Plane: /v1/sdk-config or /api/v1/sdk-config ─────────────────
  if (pathname === '/v1/sdk-config' || pathname === '/api/v1/sdk-config') {
    const baseUrl = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
    const fullConfig = buildFullFeaturedConfig(baseUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config: fullConfig }, null, 2));
    return;
  }

  // ─── Ingestion Routes: /api/v1/:route or /v1/:route ─────────────────────
  const routeMatch = pathname.match(/^\/(?:api\/)?v1\/(traces|requests|spans|errors|metrics|logs|profiles|events|crons)$/);
  if (routeMatch) {
    const route = routeMatch[1];
    const timestamp = Date.now();

    // Save full raw batch
    const batchFileName = `${route}_batch_${timestamp}_${Math.random().toString(36).slice(2, 6)}.json`;
    const batchFilePath = path.join(CUBICLE_DIR, 'raw_batches', batchFileName);
    fs.writeFileSync(batchFilePath, JSON.stringify({
      timestamp: new Date().toISOString(),
      route,
      headers: req.headers,
      payload: parsedBody,
    }, null, 2), 'utf8');

    // Extract events array
    let events = [];
    if (parsedBody && typeof parsedBody === 'object') {
      if (Array.isArray(parsedBody.events)) {
        events = parsedBody.events;
      } else if (Array.isArray(parsedBody)) {
        events = parsedBody;
      } else {
        events = [parsedBody];
      }
    }

    let savedCount = 0;
    for (const evt of events) {
      const type = (evt && typeof evt === 'object' && evt.type)
        ? String(evt.type).toLowerCase()
        : route.replace(/s$/, ''); // fallback e.g. traces -> trace

      const subDir = EVENT_DIRS[type] || route;
      const targetFolder = path.join(CUBICLE_DIR, subDir);
      fs.mkdirSync(targetFolder, { recursive: true });

      const eventId = (evt && typeof evt === 'object' && (evt.eventId || evt.id || evt.spanId || evt.traceId))
        ? String(evt.eventId || evt.id || evt.spanId || evt.traceId).replace(/[^a-zA-Z0-9_-]/g, '_')
        : Math.random().toString(36).slice(2, 10);

      const eventFileName = `${type}_${timestamp}_${eventId}.json`;
      const eventFilePath = path.join(targetFolder, eventFileName);

      fs.writeFileSync(eventFilePath, JSON.stringify(evt, null, 2), 'utf8');
      savedCount++;
      console.log(`[Pulse Mock Backend] -> Saved ${type} event (${eventId}) to cubicle/${subDir}/${eventFileName}`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', accepted: savedCount }));
    return;
  }

  // 404 fallback
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: pathname }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n================================================================`);
  console.log(`[Pulse Mock Backend] RUNNING on http://127.0.0.1:${PORT}`);
  console.log(`[Pulse Mock Backend] Logging all events to: ${CUBICLE_DIR}/<eventType>/`);
  console.log(`[Pulse Mock Backend] Every single feature is ON (100% sampling, all modules)`);
  console.log(`================================================================\n`);
});

// Handle graceful termination
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
