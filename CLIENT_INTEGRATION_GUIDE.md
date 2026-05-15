# Pulse SDK — Client-Side Integration Guide

Production-ready implementation examples for every SDK feature.

---

## 1. Installation & Setup

```bash
npm install @vikasbaplawat1/pulse-sdk
```

### Environment Variables

```env
PULSE_API_KEY=pk_live_your_api_key_here
SDK_BASE_URL=https://api.pulse.dev          # optional override
NODE_ENV=production
```

---

## 2. SDK Initialization

### Zero-Config (Recommended)

All features are **ON by default** — the backend controls what's available via your plan tier. Just pass the API key:

```typescript
// src/instrument.ts — import FIRST in your entry point
import { createSDK } from '@vikasbaplawat1/pulse-sdk'

// That's it. Errors, tracing, metrics, sessions — all ON if your plan allows.
await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
})
```

```typescript
// src/index.ts — your app entry
import './instrument.js'       // ← must be first import
import express from 'express'
// ... rest of app
```

### With Service Identity (Recommended for Production)

```typescript
await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  service: 'orders-api',
  environment: process.env.NODE_ENV ?? 'development',
  release: process.env.GIT_SHA ?? '0.0.0-local',
  debug: process.env.NODE_ENV !== 'production',
})
// All features enabled by default — plan limits applied automatically
```

### Plan-Based Feature Availability

You don't need to set `enableTracing`, `enableMetrics`, etc. — the SDK reads your plan from the backend and enables everything your plan allows:

| Feature | Free | Pro | Enterprise |
|---------|------|-----|------------|
| Error Tracking | ✅ Auto | ✅ Auto | ✅ Auto |
| Request Monitoring | ❌ | ✅ Auto | ✅ Auto |
| Distributed Tracing | ❌ | ✅ Auto | ✅ Auto |
| Metrics | ❌ | ❌ | ✅ Auto |
| Sessions | ❌ | ✅ Auto | ✅ Auto |
| Plugins | ❌ | ✅ (3 max) | ✅ Unlimited |

You **can turn OFF** features you don't need:

```typescript
await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  enableMetrics: false,  // opt-out (even if plan allows it)
})
```

But you **cannot turn ON** features above your plan — the SDK logs a clear warning:

```
[Pulse] WARN: [Plan: free] Distributed tracing requires a Pro or Enterprise plan
[Pulse] INFO: [Plan: free] 1 feature(s) adjusted to match plan limits. Upgrade at https://pulse.dev/pricing
```

### Full Configuration

```typescript
import {
  createSDK,
  monitorMiddleware,
  instrumentHttpClient,
  type SDKPlugin,
} from '@vikasbaplawat1/pulse-sdk'

await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  service: 'payments-service',
  environment: 'production',
  release: '2.4.1',
  debug: false,

  // Feature toggles
  enableErrors: true,
  enablePerformance: true,
  enableTracing: true,
  enableMetrics: true,

  // Sampling — send 50% of events
  sampleRate: 0.5,

  // Breadcrumb buffer size
  maxBreadcrumbs: 200,

  // Graceful shutdown budget
  shutdownTimeoutMs: 15_000,

  // Transport tuning
  transport: {
    batchSize: 25,
    flushIntervalMs: 5000,
    maxRetries: 3,
    timeoutMs: 8000,
    compression: 'gzip',       // 'gzip' | 'brotli' | 'none'
    maxPayloadBytes: 512_000,
    maxConcurrentSends: 5,
  },

  // Plugins
  plugins: [datadogBridgePlugin(), slackAlertPlugin()],

  // Drop events before they're sent
  beforeSend(event) {
    if (event.url === '/health') return null  // drop health checks
    return event
  },
})

// Enable auto-tracing for outbound HTTP calls
instrumentHttpClient()
```

---

## 3. Error Tracking

### Basic Error Capture

```typescript
import { captureError } from '@vikasbaplawat1/pulse-sdk'

// In a try-catch
async function processPayment(orderId: string) {
  try {
    await paymentGateway.charge(orderId)
  } catch (err) {
    captureError(err)
    throw err  // re-throw if you want the caller to handle it
  }
}
```

### Error with Context & Severity

```typescript
captureError(error, {
  severity: 'fatal',
  fingerprint: 'stripe-timeout',
  mechanism: 'try-catch',
  tags: { team: 'payments', gateway: 'stripe' },
  context: {
    orderId: 'ord_12345',
    amount: 99.99,
    currency: 'USD',
    customerId: 'cus_abc',
  },
})
```

### Express Error Handler

```typescript
import { captureError } from '@vikasbaplawat1/pulse-sdk'

// Must be registered AFTER all routes
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  captureError(err, {
    severity: 'error',
    context: {
      method: req.method,
      url: req.originalUrl,
      userId: req.user?.id,
    },
  })
  res.status(500).json({ error: 'Internal server error' })
})
```

### Capture Messages

```typescript
import { captureMessage } from '@vikasbaplawat1/pulse-sdk'

// Info-level events
captureMessage('User completed onboarding', 'info')

// Warnings
captureMessage('Rate limit approaching 80%', 'warning', {
  currentRate: 800,
  limit: 1000,
})

// Fatal alerts
captureMessage('Database connection pool exhausted', 'fatal')
```

---

## 4. Distributed Tracing

### Automatic Span Lifecycle (Recommended)

```typescript
import { withSpan } from '@vikasbaplawat1/pulse-sdk'

// Async operations — span auto-ends on completion or error
async function getUser(userId: string) {
  return withSpan('db.query.getUser', async (span) => {
    span.setAttribute('db.system', 'postgresql')
    span.setAttribute('db.statement', 'SELECT * FROM users WHERE id = $1')
    span.setAttribute('user.id', userId)

    const user = await db.query('SELECT * FROM users WHERE id = $1', [userId])

    span.setAttribute('db.rows_affected', user.rowCount)
    return user.rows[0]
  })
}
```

### Manual Span Management

```typescript
import { startSpan } from '@vikasbaplawat1/pulse-sdk'

async function processOrder(order: Order) {
  const span = startSpan('orders.process', {
    attributes: { 'order.id': order.id, 'order.total': order.total },
  })

  try {
    await validateInventory(order)
    span.addEvent('inventory.validated')

    await chargePayment(order)
    span.addEvent('payment.charged', { gateway: 'stripe' })

    await sendConfirmation(order)
    span.addEvent('confirmation.sent')

    span.setStatus('ok')
  } catch (err) {
    span.recordError(err as Error)
    span.setStatus('error', (err as Error).message)
    throw err
  } finally {
    span.end()  // always end the span
  }
}
```

### Synchronous Spans

```typescript
import { withSpanSync } from '@vikasbaplawat1/pulse-sdk'

function loadConfig() {
  return withSpanSync('config.load', (span) => {
    const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'))
    span.setAttribute('config.keys', Object.keys(config).length)
    return config
  })
}
```

### Cross-Service Context Propagation

```typescript
import { injectTraceContext, extractTraceContext } from '@vikasbaplawat1/pulse-sdk'

// ── SERVICE A: Outbound call ──
async function callServiceB(data: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  injectTraceContext(headers)  // adds traceparent, tracestate, x-pulse-trace-id

  await fetch('https://service-b.internal/api/process', {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })
}

// ── SERVICE B: Inbound handler ──
app.post('/api/process', (req, res) => {
  const context = extractTraceContext(req.headers)
  // context now contains the parent trace — child spans will link automatically
  // ...
})
```

---

## 5. Metrics

```typescript
import {
  incrementCounter,
  setGauge,
  recordHistogram,
  captureMetric,
} from '@vikasbaplawat1/pulse-sdk'

// ── Counters (monotonically increasing) ──
incrementCounter('http.requests.total', { method: 'POST', route: '/api/orders' })
incrementCounter('orders.created', { region: 'us-east-1' })
incrementCounter('cache.miss', { cache: 'redis' })

// ── Gauges (point-in-time values) ──
setGauge('connections.active', pool.activeCount, { pool: 'primary' })
setGauge('queue.depth', queue.length, { queue: 'email' })
setGauge('memory.heap_used_mb', process.memoryUsage().heapUsed / 1e6)

// ── Histograms (distributions) ──
recordHistogram('http.request.duration', responseTimeMs, {
  unit: 'ms',
  method: 'GET',
  route: '/api/users',
})
recordHistogram('db.query.duration', queryTimeMs, { db: 'users', unit: 'ms' })

// ── Generic metric capture ──
captureMetric('payment.amount', 99.99, 'histogram', {
  unit: 'usd',
  tags: { gateway: 'stripe', currency: 'USD' },
})
```

### Express Response Time Metric

```typescript
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    recordHistogram('http.server.duration', Date.now() - start, {
      method: req.method,
      route: req.route?.path ?? req.path,
      status: String(res.statusCode),
      unit: 'ms',
    })
  })
  next()
})
```

---

## 6. Breadcrumbs

```typescript
import { addBreadcrumb } from '@vikasbaplawat1/pulse-sdk'

// User actions
addBreadcrumb({
  category: 'user.action',
  message: 'Clicked "Place Order"',
  level: 'info',
  type: 'user',
  data: { buttonId: 'place-order-cta', page: '/checkout' },
})

// Database queries
addBreadcrumb({
  category: 'db.query',
  message: 'SELECT * FROM products WHERE category = $1',
  level: 'debug',
  type: 'query',
  data: { duration: 23, rows: 42, db: 'catalog' },
})

// Navigation / route changes
addBreadcrumb({
  category: 'navigation',
  message: '/cart → /checkout',
  level: 'info',
  type: 'navigation',
})

// External API calls
addBreadcrumb({
  category: 'http',
  message: 'POST https://api.stripe.com/v1/charges [200] 342ms',
  level: 'info',
  type: 'http',
  data: { method: 'POST', statusCode: 200, duration: 342 },
})
```

---

## 7. Session Management

```typescript
import { getSessionManager } from '@vikasbaplawat1/pulse-sdk'

const sessions = getSessionManager()

// Middleware — track activity per request
app.use((req, res, next) => {
  sessions.recordActivity()
  next()
})

// Error handler — mark session as crashed
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  sessions.recordError()
  next(err)
})

// Health endpoint — expose session stats
app.get('/internal/session-health', (req, res) => {
  res.json(sessions.getSessionHealth())
  // {
  //   totalSessions: 1842,
  //   crashedSessions: 12,
  //   crashFreeRate: 0.9935,
  //   currentSessionId: "a1b2c3d4...",
  //   currentSessionAge: 3600000
  // }
})
```

---

## 8. Framework Integration

### Express (Full Setup)

```typescript
import express from 'express'
import {
  createSDK,
  monitorMiddleware,
  captureError,
  instrumentHttpClient,
} from '@vikasbaplawat1/pulse-sdk'

const app = express()

// 1. Init SDK
await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  service: 'api-gateway',
  environment: 'production',
  release: '3.1.0',
})

// 2. Auto-trace outbound HTTP
instrumentHttpClient()

// 3. Per-request monitoring middleware (before routes)
app.use(monitorMiddleware)

// 4. Your routes
app.get('/api/users/:id', async (req, res) => {
  const user = await userService.findById(req.params.id)
  res.json(user)
})

// 5. Error handler (after routes)
app.use((err: Error, req: any, res: any, next: any) => {
  captureError(err, {
    context: { method: req.method, url: req.originalUrl },
  })
  res.status(500).json({ error: 'Something went wrong' })
})

app.listen(3000)
```

### Fastify (Full Setup)

```typescript
import Fastify from 'fastify'
import { createSDK, captureError, instrumentHttpClient } from '@vikasbaplawat1/pulse-sdk'
import { fastifyPulsePlugin } from '@vikasbaplawat1/pulse-sdk'

await createSDK({
  apiKey: process.env.PULSE_API_KEY!,
  service: 'order-service',
  environment: 'production',
})

instrumentHttpClient()

const app = Fastify()

// Register plugin
app.register(fastifyPulsePlugin, {
  ignorePaths: ['/health', '/ready', '/metrics'],
  captureHeaders: true,
  captureQuery: true,
})

app.get('/api/orders/:id', async (request, reply) => {
  return await orderService.findById(request.params.id)
})

app.listen({ port: 3000 })
```

---

## 9. Plugin Development

### Logging Plugin

```typescript
import type { SDKPlugin } from '@vikasbaplawat1/pulse-sdk'

function consoleLogPlugin(): SDKPlugin {
  return {
    meta: { name: 'console-log-plugin', version: '1.0.0' },

    setup(ctx) {
      console.log(`[Plugin] SDK initialized for ${ctx.config.service}`)
    },

    processEvent(event) {
      console.log(`[Plugin] Event: ${event.type}`, event.eventId)
      return event
    },

    afterSend(events) {
      console.log(`[Plugin] Sent ${events.length} events`)
    },

    onTransportError(error) {
      console.error(`[Plugin] Transport failed:`, error.message)
    },

    teardown() {
      console.log(`[Plugin] Shutting down`)
    },
  }
}
```

### PII Filter Plugin

```typescript
function piiFilterPlugin(fieldsToRedact: string[]): SDKPlugin {
  const fields = new Set(fieldsToRedact.map(f => f.toLowerCase()))

  return {
    meta: { name: 'pii-filter', version: '1.0.0' },

    processEvent(event) {
      return deepRedact(event, fields) as typeof event
    },

    processBreadcrumb(breadcrumb) {
      if (breadcrumb.data) {
        breadcrumb.data = deepRedact(breadcrumb.data, fields)
      }
      return breadcrumb
    },
  }
}

function deepRedact(obj: any, fields: Set<string>): any {
  if (!obj || typeof obj !== 'object') return obj
  const result: any = Array.isArray(obj) ? [] : {}
  for (const [key, value] of Object.entries(obj)) {
    if (fields.has(key.toLowerCase())) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = deepRedact(value, fields)
    }
  }
  return result
}

// Usage
await createSDK({
  apiKey: '...',
  plugins: [piiFilterPlugin(['password', 'ssn', 'creditCard', 'token'])],
})
```

### Slack Alert Plugin

```typescript
function slackAlertPlugin(webhookUrl: string): SDKPlugin {
  return {
    meta: { name: 'slack-alerts', version: '1.0.0' },

    processEvent(event) {
      if (event.type === 'error' && event.level === 'fatal') {
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🔴 FATAL ERROR in ${event.metadata?.sdk?.name}\n\`\`\`${event.message}\`\`\``,
          }),
        }).catch(() => { /* fire and forget */ })
      }
      return event
    },

    onTransportError(error) {
      fetch(webhookUrl, {
        method: 'POST',
        body: JSON.stringify({ text: `⚠️ SDK transport failure: ${error.message}` }),
      }).catch(() => {})
    },
  }
}
```

---

## 10. Custom Logger

```typescript
import { setLogger, type Logger } from '@vikasbaplawat1/pulse-sdk'
import pino from 'pino'

const pinoLogger = pino({ level: 'debug' })

// Replace the SDK's built-in logger with Pino
const customLogger: Logger = {
  debug(msg, ctx) { pinoLogger.debug(ctx, `[Pulse] ${msg}`) },
  info(msg, ctx)  { pinoLogger.info(ctx, `[Pulse] ${msg}`) },
  warn(msg, ctx)  { pinoLogger.warn(ctx, `[Pulse] ${msg}`) },
  error(msg, ctx) { pinoLogger.error(ctx, `[Pulse] ${msg}`) },
}

setLogger(customLogger)
```

---

## 11. Graceful Shutdown

```typescript
import { shutdown, flush } from '@vikasbaplawat1/pulse-sdk'

// Manual flush (e.g., before a deploy)
await flush()

// Full shutdown (flushes + tears down plugins + stops tracer)
await shutdown()

// Custom timeout
await shutdown(5000)  // 5 second budget

// Note: SIGTERM/SIGINT handlers are auto-registered by the SDK.
// On these signals, the SDK will flush and shut down automatically.
```

---

## 12. Event Processors & beforeSend

```typescript
await createSDK({
  apiKey: '...',

  // Transform every event before it's queued
  eventProcessors: [
    (event) => {
      // Add server metadata to all events
      event.serverRegion = process.env.AWS_REGION
      event.deploymentId = process.env.DEPLOYMENT_ID
      return event
    },
    (event) => {
      // Drop noisy low-value events
      if (event.type === 'request' && event.url?.startsWith('/internal/')) {
        return null  // dropped
      }
      return event
    },
  ],

  // Last chance to modify/drop before transport
  beforeSend(event) {
    // Scrub specific fields
    delete event.rawHeaders
    delete event.cookies

    // Drop synthetic monitoring
    if (event.headers?.['x-synthetic'] === 'true') return null

    return event
  },
})
```

---

## 13. Real-World: Complete Microservice

```typescript
// src/instrument.ts
import {
  createSDK,
  instrumentHttpClient,
  captureError,
  captureMessage,
  withSpan,
  addBreadcrumb,
  incrementCounter,
  recordHistogram,
  getSessionManager,
} from '@vikasbaplawat1/pulse-sdk'

export async function initObservability() {
  await createSDK({
    apiKey: process.env.PULSE_API_KEY!,
    service: 'checkout-service',
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.GIT_SHA ?? 'local',
    debug: process.env.NODE_ENV !== 'production',
    enableTracing: true,
    enableMetrics: true,
    transport: {
      compression: 'gzip',
      batchSize: 50,
      flushIntervalMs: 3000,
    },
    plugins: [],
    beforeSend(event) {
      if (event.url === '/health' || event.url === '/ready') return null
      return event
    },
  })

  instrumentHttpClient()
}

// src/services/checkout.ts
import { withSpan, addBreadcrumb, captureError, incrementCounter, recordHistogram }
  from '@vikasbaplawat1/pulse-sdk'

export async function processCheckout(cart: Cart, user: User) {
  return withSpan('checkout.process', async (span) => {
    span.setAttributes({
      'user.id': user.id,
      'cart.items': cart.items.length,
      'cart.total': cart.total,
    })

    // Step 1: Validate inventory
    const start1 = Date.now()
    await withSpan('checkout.validateInventory', async (s) => {
      for (const item of cart.items) {
        const available = await inventoryService.check(item.sku, item.qty)
        if (!available) {
          s.addEvent('inventory.insufficient', { sku: item.sku })
          throw new Error(`Insufficient inventory for ${item.sku}`)
        }
      }
    })
    recordHistogram('checkout.validate_inventory.duration', Date.now() - start1, { unit: 'ms' })

    addBreadcrumb({
      category: 'checkout',
      message: `Inventory validated for ${cart.items.length} items`,
      level: 'info',
      type: 'default',
    })

    // Step 2: Charge payment
    const start2 = Date.now()
    const charge = await withSpan('checkout.chargePayment', async (s) => {
      s.setAttribute('payment.gateway', 'stripe')
      s.setAttribute('payment.amount', cart.total)
      try {
        return await stripe.charges.create({ amount: cart.total, currency: 'usd' })
      } catch (err) {
        captureError(err as Error, {
          severity: 'error',
          tags: { step: 'payment' },
          context: { userId: user.id, cartTotal: cart.total },
        })
        throw err
      }
    })
    recordHistogram('checkout.charge_payment.duration', Date.now() - start2, { unit: 'ms' })
    incrementCounter('payments.charged', { gateway: 'stripe' })

    // Step 3: Create order
    const order = await withSpan('checkout.createOrder', async (s) => {
      s.setAttribute('db.system', 'postgresql')
      return await orderRepo.create({ userId: user.id, items: cart.items, chargeId: charge.id })
    })

    incrementCounter('orders.created', { region: process.env.AWS_REGION ?? 'unknown' })
    span.setAttribute('order.id', order.id)

    return order
  })
}

// src/index.ts
import './instrument.js'
import express from 'express'
import { monitorMiddleware, captureError, shutdown } from '@vikasbaplawat1/pulse-sdk'
import { initObservability } from './instrument.js'
import { processCheckout } from './services/checkout.js'

await initObservability()

const app = express()
app.use(express.json())
app.use(monitorMiddleware)

app.post('/api/checkout', async (req, res) => {
  try {
    const order = await processCheckout(req.body.cart, req.body.user)
    res.json({ orderId: order.id })
  } catch (err) {
    captureError(err as Error)
    res.status(500).json({ error: 'Checkout failed' })
  }
})

app.get('/health', (_, res) => res.json({ status: 'ok' }))

const server = app.listen(3000, () => console.log('Listening on :3000'))

process.on('SIGTERM', async () => {
  server.close()
  await shutdown()
  process.exit(0)
})
```

---

## 14. TypeScript Types — Quick Reference

```typescript
import type {
  // Config
  SDKInitOptions, TransportOptions, ResolvedSDKConfig,

  // Events
  SDKEvent, ErrorEvent, RequestEvent, MessageEvent, MetricEvent,

  // Plugins
  SDKPlugin, PluginMeta, PluginContext, EventProcessor,

  // Breadcrumbs
  BreadcrumbInput, Breadcrumb,

  // Tracing
  SpanOptions, SpanStatus,

  // Session
  Session, SessionManagerOptions,

  // Transport
  TransportAdapter, TransportResult,

  // Error
  CaptureErrorOptions,

  // Severity
  SeverityLevel,

  // Logger
  Logger,
} from '@vikasbaplawat1/pulse-sdk'
```
