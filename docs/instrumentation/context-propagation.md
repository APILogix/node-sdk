# Context Propagation & AsyncLocalStorage

## 1. Request Context Architecture

Node.js executes multiple concurrent requests on a single-threaded event loop. To associate child spans, database queries, breadcrumbs, and user metadata with the correct HTTP request, Pulse leverages Node.js `AsyncLocalStorage`.

The context engine resides in [`src/core/context.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/context.ts) and [`src/tracing/context-propagation.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/context-propagation.ts).

---

## 2. Inbound Context Initialization

When an HTTP request enters `monitorMiddleware()`:

```typescript
const contextStore = createContextStore({
  traceId: incomingTraceId || generateTraceId(),
  spanId: generateSpanId(),
  sampled: true,
  breadcrumbs: [],
  scope: new Scope(),
});

contextStore.run(() => {
  // All downstream asynchronous calls inherit this store
  next();
});
```

---

## 3. Distributed Context Headers (W3C Standard)

Pulse fully complies with the W3C Distributed Tracing specification.

### 3.1 Inbound Extraction (`extractTraceContext`)
When an inbound request arrives from another service or API gateway:
```typescript
import { extractTraceContext } from '@pulse-apm/node';

const context = extractTraceContext(req.headers);
// Parses:
// traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
// baggage: userId=alice,role=admin
```

### 3.2 Outbound Injection (`injectTraceContext`)
When dispatching outbound HTTP requests:
```typescript
import { injectTraceContext } from '@pulse-apm/node';

const headers = {};
injectTraceContext(headers);
// Appends traceparent and baggage to outgoing headers
await fetch('https://payment-service/api', { headers });
```

---

## 4. Scope & Breadcrumbs Management

Within any active asynchronous request context, developers can attach diagnostics:

```typescript
import { setUser, setTag, setExtra, addBreadcrumb } from '@pulse-apm/node';

// Attach User Identity to the active trace
setUser({ id: 'usr_88291', email: 'alice@company.com' });

// Add custom searchable tags
setTag('tenant', 'enterprise_tier_1');

// Record a breadcrumb
addBreadcrumb({
  category: 'auth',
  message: 'User verified via MFA token',
  level: 'info',
});
```

All metadata set via `setUser()`, `setTag()`, or `addBreadcrumb()` is automatically bound to the active `AsyncLocalStorage` store and attached to any errors or traces emitted within that request execution tree.
