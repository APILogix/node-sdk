# Pulse SDK — Backend Integration Flow Document

This document outlines the step-by-step lifecycle and flow for implementing the Pulse Node.js SDK across a backend environment.

---

## 1. SDK Initialization (Application Startup)

Initialization must happen **before** any other modules (like Express, HTTP, or databases) are imported. This allows the OpenTelemetry auto-instrumentation to hook into `require` calls.

```mermaid
sequenceDiagram
    participant App as Backend Service
    participant SDK as Pulse SDK
    participant OTel as OpenTelemetry
    
    App->>SDK: init({ apiKey, service, environment })
    
    rect rgb(240, 248, 255)
        Note over SDK,OTel: Setup Phase
        SDK->>SDK: Resolve Config & Validate
        SDK->>OTel: Initialize Resource & TracerProvider
        SDK->>OTel: Register Auto-Instrumentations (HTTP, Express, etc.)
        SDK->>SDK: Boot Event Pipeline & Storage
        SDK->>SDK: Connect Governance (Memory, Queue, Cardinality)
    end
    
    SDK-->>App: SDK Initialized (Non-blocking)
```

**Implementation Code:**
```typescript
import { init } from '@vikasbaplawat1/pulse-sdk';

init({
  apiKey: process.env.PULSE_API_KEY,
  service: 'user-service',
  environment: process.env.NODE_ENV || 'development',
  release: process.env.npm_package_version,
  enableTracing: true, // Auto-instruments HTTP/Express/Fastify
  enableMetrics: true
});

// Important: Import your server/app AFTER init()
import { app } from './app';
```

---

## 2. Request Lifecycle & Context Enrichment

Because the SDK utilizes OpenTelemetry's `AsyncLocalStorageContextManager`, all context is automatically propagated across asynchronous boundaries.

You only need to enrich the context once per request (typically via a middleware).

```mermaid
sequenceDiagram
    participant Client
    participant Express as Express App
    participant SDK as Pulse SDK
    
    Client->>Express: HTTP GET /api/users
    
    rect rgb(255, 240, 245)
        Note over Express,SDK: Middleware Enrichment
        Express->>SDK: setTenantId('tenant_123')
        Express->>SDK: setUserId('user_456')
        SDK->>SDK: Store in OTel AsyncLocalStorage
    end
    
    Express->>Express: Process Request (DB calls, external API)
    
    rect rgb(240, 255, 240)
        Note over Express,SDK: Automatic Tracing
        Express->>SDK: (Implicit via OTel) capture HTTP/DB Spans
        SDK->>SDK: Enrich Spans with Tenant/User Context
    end
    
    Express-->>Client: 200 OK
```

**Implementation Code:**
```typescript
import { setContext, setTenantId, setUserId } from '@vikasbaplawat1/pulse-sdk';

app.use((req, res, next) => {
  // Bind standard attributes for the entire request lifecycle
  if (req.user) setUserId(req.user.id);
  if (req.tenant) setTenantId(req.tenant.id);
  
  // Custom business context
  setContext({
    route: req.path,
    region: 'us-east-1'
  });
  
  next();
});
```

---

## 3. Manual Tracing (Custom Business Logic)

While HTTP and Database calls are auto-instrumented, you can wrap complex custom business logic in spans to measure exact execution times.

```mermaid
sequenceDiagram
    participant App as Backend Service
    participant SDK as Pulse SDK
    
    App->>SDK: withSpan('process_payment', fn)
    SDK->>SDK: Create OTel Span
    App->>App: Execute `fn` (Payment Logic)
    App-->>SDK: Function finishes (or throws)
    SDK->>SDK: Record Status (OK/Error)
    SDK->>SDK: End Span -> Export to Event Pipeline
```

**Implementation Code:**
```typescript
import { withSpan } from '@vikasbaplawat1/pulse-sdk';

async function processPayment(orderId: string) {
  // This wraps the execution in a span and measures duration automatically
  return await withSpan('process_payment', async (span) => {
    span.setAttribute('orderId', orderId);
    
    const result = await stripe.charges.create({ ... });
    span.setAttribute('chargeId', result.id);
    
    return result;
  }); // Span safely closed even if stripe.charges throws
}
```

---

## 4. Error Capture & Breadcrumbs

Errors caught by Express/Global handlers can be captured. Breadcrumbs are tracked automatically for network requests but can be added manually.

```mermaid
sequenceDiagram
    participant App as Backend Service
    participant SDK as Pulse SDK
    
    App->>SDK: addBreadcrumb('User clicked checkout')
    App->>App: (Exception Thrown)
    App->>SDK: captureError(error)
    
    rect rgb(255, 250, 205)
        Note over SDK: Error Processing Pipeline
        SDK->>SDK: Extract Stack Trace & V8 CallSites
        SDK->>SDK: De-obfuscate via Source Maps (source-map-js)
        SDK->>SDK: Attach Breadcrumbs & Trace Context
        SDK->>SDK: Generate Grouping Fingerprint
        SDK->>SDK: Enqueue for Export
    end
```

**Implementation Code:**
```typescript
import { captureError, addBreadcrumb } from '@vikasbaplawat1/pulse-sdk';

app.post('/checkout', async (req, res) => {
  addBreadcrumb({
    category: 'business_logic',
    message: 'Starting checkout process',
    data: { cartSize: req.body.items.length }
  });

  try {
    await processPayment(req.body);
  } catch (error) {
    // Captures the error, stack trace, active traceId, and recent breadcrumbs
    captureError(error, {
      context: { cartSize: req.body.items.length },
      severity: 'error'
    });
    res.status(500).send('Checkout failed');
  }
});
```

---

## 5. Shutdown and Cleanup

When the Node.js process shuts down (e.g., Kubernetes scaling down), you must flush the SDK to ensure no telemetry is lost in the queues.

```typescript
import { shutdown } from '@vikasbaplawat1/pulse-sdk';

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  
  // Closes the server
  server.close();

  // Flushes OTel exporters, writes persistent queues to disk, and closes connections
  await shutdown(5000); // Wait up to 5s to flush
  
  process.exit(0);
});
```
