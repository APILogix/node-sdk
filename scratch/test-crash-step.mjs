import http from 'http';
import { Pulse } from '@pulse-apm/node';
import { emergencyFlush } from '../dist/core/lifecycle.js';

function getValidMockConfig(baseUrl) {
  const routes = {};
  for (const r of ['traces', 'requests', 'spans', 'errors', 'logs', 'metrics', 'profiles', 'crons', 'replays', 'events']) {
    routes[r] = {
      url: `${baseUrl}/v1/${r}`,
      batchSize: 10,
      flushIntervalMs: 500,
      timeoutMs: 3000,
      compression: 'gzip',
      priority: r === 'errors' ? 'critical' : 'normal'
    };
  }

  return {
    schemaVersion: 1,
    sdk: { projectId: 'p', service: 's', environment: 'production', release: '1.0.0' },
    features: { tracing: false, requestCapture: false, errors: true, metrics: false, logging: false, profiling: false, crons: false, sessionReplay: false, runtimeMetrics: false, eventLoopMonitoring: false, gcMonitoring: false },
    sampling: { traces: 1.0, requests: 1.0, spans: 1.0, errors: 1.0, messages: 1.0, profiles: 1.0, replays: 1.0, metrics: 1.0, logs: 1.0, events: 1.0, crons: 1.0, routes: {} },
    instrumentation: { http: true, https: true, fetch: true, axios: true, fastify: { enabled: true, captureHooks: true, captureValidationErrors: true }, express: { enabled: true }, graphql: { enabled: false, captureResolvers: false }, prisma: { enabled: false, captureQueries: false, captureParams: false }, mongodb: false, redis: false, bullmq: false, pg: false, mysql2: false, eventEmitterPatch: true },
    privacy: { capture: { headers: true, body: true, response: false, query: true, cookies: false }, scrubbing: { enabled: true, headers: ['authorization'], fields: ['password'] }, piiDetection: { enabled: true, maskEmails: true, maskPhones: true, maskIPs: true } },
    limits: { maxSpansPerTrace: 500, maxSpanAttributes: 100, maxAttributeLength: 2048, maxPayloadSize: 1048576, maxQueueSize: 10000, maxMemoryMb: 512, tenantGovernance: { enabled: false, maxTenantsTracked: 1000, quotaPerWindow: 10000, windowDurationMs: 60000, criticalReserve: 100 }, persistenceGovernance: { maxPersistPerMinute: 20000, adaptive: true, budgetExceededLogIntervalMs: 60000 } },
    killswitches: { disableSDK: false, disableTracing: false, disableMetrics: false, disableTransport: false, disableProfiling: false, disableErrors: false, disableLogs: false },
    entitlements: { customSpans: true, customMetrics: true, profiling: false, logging: true, sessionReplay: false, crons: false, requestCapture: false, tracing: true, errors: true, metrics: true },
    transport: { retry: { enabled: true, maxRetries: 3, backoff: 'exponential', baseDelayMs: 200 }, queue: { overflowStrategy: 'drop_oldest', maxSize: 10000, criticalReserve: 100 }, connections: { maxTotalConnections: 50, acquireTimeoutMs: 5000 }, keepAlive: true, routes },
    meta: { generatedAt: new Date().toISOString(), generatedBy: 'test-harness' }
  };
}

const server = http.createServer((req, res) => {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (req.url === '/v1/init') {
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ success: true, projectId: 'p', environment: 'production', release: '1.0.0', config: getValidMockConfig(baseUrl) }));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ success: true, accepted: 1 }));
  }
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${server.address().port}`;
process.env['PULSE_ENDPOINT'] = endpoint;

await Pulse.init({
  apiKey: 'shutdown_live_key_99999999999999999999999999',
  debug: false,
  crashTimeoutMs: 1500,
  exitOnUncaughtException: false
});

Pulse.captureMessage('Pre-crash canary message');
Pulse.captureException(new Error('Fatal unhandled crash for release audit'));

console.log('Running emergencyFlush...');
await emergencyFlush(1500);
console.log('emergencyFlush done.');
const pool = (await import('../dist/transport/serialization-pool.js')).SerializationPool.getInstance();
if (pool) {
  console.log('Shutting down SerializationPool...');
  await pool.shutdown();
  console.log('SerializationPool shutdown complete.');
  await new Promise(r => setTimeout(r, 50));
}
console.log('Calling process.exit(1)...');
process.exit(1);
