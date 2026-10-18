import {
  init,
  captureException,
  captureMessage,
  captureRequest,
  captureEvent,
  captureLog,
  captureMetric,
  captureCronCheckIn,
  startProfile,
  stopProfile,
  withSpan,
  startSpan,
  flush,
  shutdown,
} from '../dist/index.js';

process.env.SDK_BASE_URL = process.env.SDK_BASE_URL || 'http://127.0.0.1:5055';
process.env.SDK_BASE_URL = process.env.SDK_BASE_URL || 'http://127.0.0.1:5000';

console.log('[SDK Emitter] Initializing SDK pointing to:', process.env.SDK_BASE_URL);

const config = await init({
  apiKey: 'pv_live_test_api_key_cubicle_1234567890',
  applicationName: 'cubicle-backend-demo',
  applicationVersion: '8.0.0',
  debug: true,
});

console.log('[SDK Emitter] SDK initialized successfully! Active features:', Object.keys(config?.features || {}));

// 1. Error event
console.log('[SDK Emitter] 1. Emitting Error event...');
captureException(new Error('Simulated Cubicle Database Connection Timeout'), {
  severity: 'error',
  tags: { module: 'cubicle-core', environment: 'production' },
  extra: { retryAttempt: 3, host: 'mongodb.internal' },
});

// 2. Message event
console.log('[SDK Emitter] 2. Emitting Message event...');
captureMessage('User authentication session refreshed successfully', {
  level: 'info',
  tags: { userId: 'usr_cubicle_9981' },
});

// 3. Request event
console.log('[SDK Emitter] 3. Emitting Request event...');
captureRequest({
  type: 'request',
  requestId: 'req-cubicle-101',
  method: 'POST',
  url: '/api/v1/projects/cubicle/deploy',
  route: '/api/v1/projects/:id/deploy',
  statusCode: 200,
  latency: 42.5,
  timestamp: Date.now(),
  clientIp: '192.168.1.100',
  userAgent: 'CubicleClient/8.0.0',
  headers: { 'x-request-id': 'req-cubicle-101' },
  body: { deployTarget: 'staging-cluster', commitSha: 'a1b2c3d4' },
});

// 4. Trace & Span events
console.log('[SDK Emitter] 4. Emitting Trace and Span events...');
await withSpan({ name: 'cubicle.handleHttpRequest', op: 'http.server' }, async (serverSpan) => {
  serverSpan.setAttribute('http.route', '/api/v1/orders');
  await withSpan({ name: 'cubicle.mongodb.query', op: 'db.query' }, async (dbSpan) => {
    dbSpan.setAttribute('db.system', 'mongodb');
    dbSpan.setAttribute('db.collection', 'orders');
    dbSpan.setAttribute('db.statement', 'orders.find({ status: "pending" })');
    await new Promise((r) => setTimeout(r, 20));
  });
});

// 5. Metric event
console.log('[SDK Emitter] 5. Emitting Metric events...');
captureMetric('cubicle.active_users', 1240, 'gauge', { tags: { plan: 'enterprise' } });
captureMetric('cubicle.api.latency_ms', 38.2, 'histogram', { tags: { route: '/deploy' } });
captureEvent({
  type: 'metric',
  metricName: 'cubicle.direct_metric',
  metricType: 'gauge',
  value: 42,
  tags: { source: 'direct_capture' },
  timestamp: Date.now(),
});

// 6. Log event
console.log('[SDK Emitter] 6. Emitting Log event...');
captureLog('warn', 'Payment gateway response latency exceeded 500ms threshold', {
  gateway: 'stripe',
  latencyMs: 512,
});

// 7. Cron check-in event
console.log('[SDK Emitter] 7. Emitting Cron check-in event...');
captureCronCheckIn('cubicle-nightly-billing-sync', 'in_progress');
captureCronCheckIn('cubicle-nightly-billing-sync', 'ok');

// 8. Profile event
console.log('[SDK Emitter] 8. Emitting Profile event...');
const profId = startProfile('cubicle-checkout-pipeline');
await new Promise((r) => setTimeout(r, 30));
stopProfile(profId);
// 9. Flush and shutdown
console.log('[SDK Emitter] Flushing all buffers to mock backend...');
await flush(5000);
await shutdown(5000);
console.log('[SDK Emitter] All events flushed and SDK shutdown cleanly.');
