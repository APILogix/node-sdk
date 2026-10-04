# Express & Fastify Framework Instrumentation

## 1. Express.js Integration

Pulse provides native middleware for Express applications in [`src/instrumentation/express.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/express.ts).

### 1.1 Usage Example
```typescript
import express from 'express';
import { init, monitorMiddleware, expressErrorHandler } from '@pulse-apm/node';

await init({ apiKey: process.env.PULSE_API_KEY! });

const app = express();

// 1. MUST BE FIRST MIDDLEWARE: Captures request timing and binds AsyncLocalStorage
app.use(monitorMiddleware());

// Application routes
app.get('/users/:id', async (req, res) => {
  res.json({ id: req.params.id });
});

// 2. MUST BE LAST MIDDLEWARE: Catches unhandled Express errors
app.use(expressErrorHandler());

app.listen(3000);
```

### 1.2 What `monitorMiddleware` Does:
1. **Context Initialization:** Creates a fresh `RequestContext` in `AsyncLocalStorage` so all downstream database queries and function traces inherit the root HTTP trace.
2. **Route Normalization:** Extracts parameterized route templates (e.g., `GET /api/v1/orders/:id`) rather than raw URLs with dynamic IDs (`/api/v1/orders/991823`), preventing high-cardinality route explosion.
3. **Response Listener:** Hooks into `res.on('finish')` to compute accurate transaction durations and response status codes.

---

## 2. Fastify Integration

For Fastify applications, Pulse provides a dedicated plugin in [`src/instrumentation/fastify.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/fastify.ts).

### Usage Example:
```typescript
import Fastify from 'fastify';
import { init, fastifyPulsePlugin } from '@pulse-apm/node';

await init({ apiKey: process.env.PULSE_API_KEY! });

const fastify = Fastify();

// Register Pulse plugin
await fastify.register(fastifyPulsePlugin, {
  captureBody: false,
  captureHeaders: true,
});

fastify.get('/health', async () => ({ status: 'ok' }));

await fastify.listen({ port: 3000 });
```

The Fastify plugin utilizes Fastify's native lifecycle hooks (`onRequest`, `onResponse`, `onError`) for zero-overhead transaction tracking.
