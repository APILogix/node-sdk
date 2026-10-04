# Manual Tracing & Function Decoration

## 1. Overview

While automatic instrumentation tracks HTTP requests and database queries, critical application business logic (financial calculations, cache lookups, encryption, external third-party calls) requires custom span instrumentation.

Pulse provides ergonomic tracing utilities in [`src/tracing/tracer.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/tracer.ts).

---

## 2. Asynchronous Tracing (`withSpan`)

`withSpan` wraps an async block, automatically ending the span when the Promise settles and recording any thrown exceptions:

```typescript
import { withSpan } from '@pulse-apm/node';

const order = await withSpan('order.processCheckout', async (span) => {
  span.setAttribute('order.id', orderId);
  span.setAttribute('order.amount', amount);

  const validation = await validatePayment(orderId);
  span.addEvent('payment_validated', { gateway: 'stripe' });

  return await finalizeOrder(orderId);
});
```

---

## 3. Synchronous Tracing (`withSpanSync`)

For CPU-intensive synchronous operations:

```typescript
import { withSpanSync } from '@pulse-apm/node';

const hash = withSpanSync('crypto.hashPassword', (span) => {
  span.setAttribute('crypto.algorithm', 'argon2');
  return computeHash(password);
});
```

---

## 4. Zero-Boilerplate Function Decoration (`wrap` / `trace`)

The `wrap` and `trace` helpers instrument existing functions without modifying their call sites:

```typescript
import { wrap } from '@pulse-apm/node';

const calculateTax = wrap('tax.calculate', async (subtotal: number, country: string) => {
  return await taxService.lookup(subtotal, country);
});

// Calls automatically generate a child span
const total = await calculateTax(100.0, 'US');
```

---

## 5. Detached Background Work (`withBackgroundSpan`)

In modern web applications, servers often respond to the user immediately and dispatch asynchronous tasks (sending emails, updating analytics, publishing to Kafka) in the background:

```
[ Inbound HTTP Request ] ──> HTTP Response Sent (Trace Ends)
                                    |
                           (Background Work Started)
                                    |
                                    v
                     [ Post-Response Background Trace ]
                     (Causally linked via SpanLink)
```

If background tasks are executed within the original request context, the HTTP trace cannot close, leading to unbounded memory retention.

Pulse provides `withBackgroundSpan` ([`src/tracing/tracer.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/tracer.ts#L180)):

```typescript
import { withBackgroundSpan } from '@pulse-apm/node';

app.post('/orders', async (req, res) => {
  const orderId = await createOrder(req.body);
  res.json({ status: 'created', orderId }); // HTTP Response finishes

  // Detached background work executes safely
  withBackgroundSpan('email.sendReceipt', async (bgSpan) => {
    bgSpan.setAttribute('order.id', orderId);
    await mailer.sendReceipt(orderId);
  });
});
```

### How It Works:
- Clones parent trace identifiers (`TraceId`) for causal linkage.
- Disconnects the background operation from the HTTP request context lifecycle.
- Uses OpenTelemetry `SpanLink` to connect the background trace to the root transaction without preventing HTTP trace finalization.
