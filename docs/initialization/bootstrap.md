# Bootstrap Instrumentation

## 1. The Startup Ordering Dilemma

In Node.js applications, modules are evaluated in the order they are imported:

```javascript
import { init } from '@pulse-apm/node';
import pg from 'pg'; // <-- PostgreSQL Pool created here!

await init({ apiKey: '...' });
```

If database drivers (such as `pg`, `mysql2`, `mongodb`, or `redis`) or framework listeners (such as `http.createServer`) are evaluated before `await init()` completes its network handshake, standard auto-instrumentation will miss patching the classes, leading to missing database spans and untracked HTTP requests.

To solve this ordering dilemma without blocking module evaluation, the Pulse SDK implements **Bootstrap Instrumentation**.

---

## 2. Execution on Import

In [`src/index.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L51-L53):

```typescript
import { registerBootstrapAutoInstrumentations } from './instrumentation/auto-instrument.js';

registerBootstrapAutoInstrumentations();
```

The moment `@pulse-apm/node` is imported (or preloaded via `node --import @pulse-apm/node/register` or `node -r @pulse-apm/node/register`), `registerBootstrapAutoInstrumentations()` executes synchronously.

### What Bootstrap Hooks Do:
1. Intercept `http.get`, `http.request`, `https.get`, `https.request`.
2. Intercept database connection constructors (`pg.Pool`, `redis.createClient`, `MongoClient`).
3. Maintain inactive or dormant span wrappers that check SDK state at runtime.

---

## 3. Dynamic Configuration Upgrade (No Duplicate Patches)

When `init()` eventually completes—whether immediately via `/v1/init` or minutes later via background recovery—the SDK must apply remote instrumentation directives without monkey-patching libraries a second time.

In [`src/instrumentation/auto-instrument.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/auto-instrument.ts):

```typescript
let bootstrapRegistered = false;
let fullyConfigured = false;

export function registerBootstrapAutoInstrumentations(): void {
  if (bootstrapRegistered) return;
  bootstrapRegistered = true;
  // Apply early interceptors with default configuration
}

export function upgradeAutoInstrumentations(remoteConfig: RemoteConfigResponse): void {
  if (fullyConfigured) return;
  fullyConfigured = true;
  // Update internal configuration references on existing hooks
  // DO NOT re-wrap or duplicate shimmer monkey patches!
}
```

### Safety Invariants:
- **Zero Duplicate Spans:** Each intercepted function retains a single interceptor wrapper.
- **Dynamic Feature Flags:** If remote config disables MongoDB tracing (`features.tracing.mongodb: false`), the existing hook transitions into a high-performance no-op bypass without unpatching or repatching the driver.
- **Recovery Resilient:** Multiple recovery cycles do not register additional hooks or cause memory leaks.
