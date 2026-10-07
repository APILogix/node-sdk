# Graceful Shutdown & Signal Handlers

## 1. Automatic Process Signal Interception

By default, Pulse registers listeners on `process.on('SIGTERM')` and `process.on('SIGINT')` during initialization.

When a termination signal is received (such as during a Kubernetes rolling pod deployment or Docker container stop), the signal handler initiates `shutdown()` automatically, flushing in-flight batches before the process terminates.

---

## 2. Coordinating with Application Shutdown

In standard Node.js microservices, the application typically coordinates its own teardown:

```typescript
import express from 'express';
import { init, shutdown } from '@pulse-apm/node';

await init({ apiKey: process.env.PULSE_API_KEY! });

const app = express();
const server = app.listen(3000);

// Coordinated Application Teardown
async function onShutdown(signal: string) {
  console.log(`Received ${signal}, starting graceful teardown...`);

  // 1. Stop accepting new HTTP traffic
  server.close(() => console.log('HTTP server closed'));

  // 2. Close database pools
  await db.pool.end();

  // 3. Flush and terminate Pulse SDK
  await shutdown(2000);

  console.log('Teardown complete, exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT', () => onShutdown('SIGINT'));
```

---

## 3. Disabling Built-in Signal Handlers

If an application manages its own complex process orchestrator and prefers Pulse not to intercept process signals directly, signal registration can be disabled:

```typescript
await init({
  apiKey: '...',
  registerSignalHandlers: false, // Disables automatic SIGTERM/SIGINT hooks
});
```

When disabled, the developer is responsible for calling `await shutdown()` inside their custom termination handler.
