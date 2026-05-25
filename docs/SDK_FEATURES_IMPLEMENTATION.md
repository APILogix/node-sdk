# SDK Features Implementation Guide

This document describes how each major feature is implemented in the Pulse SDK for Node.js.

---

## Table of Contents

1. [Sampling Engine](#1-sampling-engine)
2. [Config Manager](#2-config-manager)
3. [Killswitch Engine](#3-killswitch-engine)
4. [Limits Engine](#4-limits-engine)
5. [Tenant Isolation (Tenant Governor)](#5-tenant-isolation-tenant-governor)
6. [Event Pipeline](#6-event-pipeline)
7. [Auto Instrumentation](#7-auto-instrumentation)
8. [Feature Controller](#8-feature-controller)
9. [Transport & Queue System](#9-transport--queue-system)
10. [Security & Data Scrubbing](#10-security--data-scrubbing)

---

## 1. Sampling Engine

### Overview

The SamplingEngine provides **deterministic, FNV-1a hash-based sampling** to ensure consistent sampling decisions across all SDK instances.

### Key Features

- **Deterministic Decisions**: Same traceId → same decision across all SDK instances
- **Route-specific Overrides**: Different sampling rates per route (e.g., `/api/health` = 0 to always drop)
- **Dynamic Rate Updates**: Hot-swap sampling rates via config refresh without restart
- **Multiple Event Types**: Supports traces, errors, profiles, and replays

### Algorithm

```javascript
// 1. Compute FNV-1a 32-bit hash of the traceId (or eventId)
const hash = SamplingEngine.fnv1a32(traceId);

// 2. Normalize to [0.0, 1.0] via hash / 2^32
const normalized = hash / 0x100000000;

// 3. Compare against the sampling rate for the event type
return normalized < samplingRate;
```

### API Usage

```javascript
const samplingEngine = SamplingEngine.getInstance();

// Check if a trace should be sampled
const result = samplingEngine.shouldSampleTrace('trace-123', '/api/users');
// Returns: { sampled: true/false, rate: 0.5, reason: 'global_rate' | 'route_override' }

// Route-specific sampling
samplingEngine.shouldSampleTrace('trace-456', '/api/health');
// Returns: { sampled: false, rate: 0, reason: 'always_drop' }

// Error sampling
samplingEngine.shouldSampleError('event-789');
```

### Config Structure

```javascript
{
  sampling: {
    traces: 0.5,        // 50% of traces
    errors: 1.0,        // 100% of errors
    profiles: 0.1,      // 10% of profiles
    replays: 0.01,      // 1% of session replays
    routes: {
      '/api/health': 0,    // Always drop health checks
      '/api/users': 1.0    // Always sample user API
    }
  }
}
```

---

## 2. Config Manager

### Overview

The ConfigManager is the **single source of truth for SDK configuration**. It fetches remote config, manages hot-reload, and provides atomic config reads.

### Key Features

- **Remote Config Fetch**: Fetches config from backend with 3-second timeout race
- **Safe Defaults**: Falls back to SAFE_DEFAULTS if fetch fails (all features off)
- **Config Merge Priority**: Baked-in defaults → Remote Config → User init() options (last wins)
- **Background Refresh**: Periodic refresh at `cache.ttlSeconds` interval
- **staleWhileRevalidate**: Serves stale config while fetching new one
- **Immutable Snapshots**: All config reads return frozen objects

### Initialization Flow

```javascript
const configManager = ConfigManager.getInstance();

await configManager.initialize({
  configUrl: 'https://api.example.com/v1/sdk-config',
  baseUrl: 'https://api.example.com',
  apiKey: 'your-api-key',
  service: 'my-service',
  environment: 'production',
  sampleRate: 0.5  // User override
});

// Get frozen config snapshot
const config = configManager.getConfig();
```

### Config Change Listening

```javascript
const unsubscribe = configManager.onConfigChange((diff, newConfig) => {
  console.log('Config changed:', diff);
  // Handle specific changes:
  if (diff.samplingChanged) {
    // Update sampling rates
  }
  if (diff.featuresChanged) {
    // Update feature flags
  }
});

// Unsubscribe when done
unsubscribe();
```

### Config Structure

```javascript
{
  features: { tracing: true, errors: true, metrics: true, logging: true },
  killswitches: { disableSDK: false, disableTracing: false, ... },
  sampling: { traces: 0.5, errors: 1.0, ... },
  limits: { maxEventsPerSecond: 1000, maxBreadcrumbs: 100, ... },
  security: { scrubbing: { headers: ['Authorization'], bodyFields: ['password'] } },
  cache: { ttlSeconds: 300, staleWhileRevalidate: true }
}
```

---

## 3. Killswitch Engine

### Overview

The KillswitchEngine provides **reactive killswitch control** for subsystems. When a killswitch flips via config refresh, the engine reacts within 5 seconds.

### Available Killswitches

| Killswitch | Description |
|------------|-------------|
| `disableSDK` | Every public method becomes a no-op. Zero data capture. |
| `disableTracing` | Shut down TracerProvider, flush existing, destroy exporter |
| `disableMetrics` | Stop metric reader loop, flush, stop collection |
| `disableErrors` | Detach exception listeners, stop error capture |
| `disableLogs` | Stop console interception, drain buffer |
| `disableProfiling` | Stop profiler thread, flush in-flight profiles |
| `disableTransport` | Stop all HTTP outbound. Events queued locally. |

### Usage

```javascript
const killswitchEngine = KillswitchEngine.getInstance();

// Check if SDK is globally disabled
if (killswitchEngine.isSDKDisabled()) {
  console.log('SDK is disabled');
}

// Check specific subsystem
if (killswitchEngine.isKilled('disableTracing')) {
  console.log('Tracing is disabled');
}

// Register subsystem handlers
killswitchEngine.registerSubsystem('disableTracing', {
  shutdown: async () => {
    await tracerProvider.shutdown();
  },
  startup: async () => {
    await initTracer();
  }
});
```

---

## 4. Limits Engine

### Overview

The LimitsEngine enforces **payload and resource limits** from remote config. All enforcement happens pre-transport.

### Key Features

- **Token Bucket Rate Limiting**: `maxEventsPerSecond` with token bucket algorithm
- **Attribute Limits**: Trim excess attributes, truncate long values
- **Payload Size Check**: Reject payloads exceeding `maxPayloadSize`
- **Breadcrumb Cap**: Ring buffer for breadcrumbs
- **Resource Monitoring**: Log warnings for memory/CPU thresholds

### Usage

```javascript
const limitsEngine = LimitsEngine.getInstance();

// Check if event can be admitted (rate limiting)
if (!limitsEngine.admitEvent()) {
  console.log('Rate limited');
  return;
}

// Enforce attribute limits on event
const trimmedEvent = limitsEngine.enforceAttributeLimits(event);

// Check payload size
const serialized = JSON.stringify(payload);
if (!limitsEngine.checkPayloadSize(serialized.length)) {
  console.log('Payload too large');
}

// Get drop statistics
const dropped = limitsEngine.getDroppedCount();
```

### Config Structure

```javascript
{
  limits: {
    maxEventsPerSecond: 1000,
    maxPayloadSize: 1024 * 1024,        // 1MB
    maxAttributesPerEvent: 200,
    maxAttributeLength: 512,
    maxBreadcrumbs: 100,
    maxMemoryUsageMb: 512,
    maxCpuOverheadPercent: 10
  }
}
```

---

## 5. Tenant Isolation (Tenant Governor)

### Overview

The TenantGovernor provides **multi-tenant governance** in a shared SDK runtime. One SDK instance serves all tenants with per-tenant rate limiting.

### Key Features

- **Per-tenant Sliding Window Rate Limiting**
- **Fair Scheduling Across Tenants**
- **Starvation Prevention**
- **LRU Eviction for Tenant Tracking**

### Usage

```javascript
const tenantGovernor = new TenantGovernor({
  maxTenantsTracked: 1000,
  defaultQuotaPerTenant: 100,
  windowDurationMs: 60_000  // 1 minute
});

// Check if tenant can accept event
const tenantId = 'tenant-123';
if (!tenantGovernor.canAcceptEvent(tenantId)) {
  console.log('Tenant rate limited');
  return;
}

// Record accepted event
tenantGovernor.recordEvent(tenantId);

// Get statistics
const stats = tenantGovernor.getStats();
/*
{
  activeTenants: 50,
  throttledTenants: 2,
  totalThrottled: 150
}
*/
```

---

## 6. Event Pipeline

### Overview

The Event Pipeline is the **central async processing system** for all events. It uses a deferred async model to avoid blocking the caller's request lifecycle.

### Pipeline Stages

```
capture → accept → [setImmediate] → normalize → sanitize → enrich →
dedup → scope → plugin processors → beforeSend → route → persist
```

### Key Features

- **Non-blocking**: Processing deferred via `setImmediate()`
- **Priority-aware**: Critical events (errors) always persisted
- **Memory Pressure Detection**: Drop low-priority events under pressure
- **Load Shedding**: Adaptive pressure-based event dropping
- **Crash Recovery**: Persistent storage for critical events

### Usage

```javascript
import { enqueueEvent } from './core/event-pipeline.js';

// Enqueue event with full lifecycle tracking
const receipt = enqueueEvent({
  type: 'error',
  message: 'Something went wrong',
  stack: error.stack
});

if (!receipt.accepted) {
  console.log('Event rejected:', receipt.reason);
  return;
}

// Await processing completion (for shutdown/flush)
await receipt.processed;
console.log('Event processed');
```

### Event Receipt

```typescript
interface EventReceipt {
  accepted: boolean;      // Event entered pipeline
  eventId: string;        // Assigned event ID
  reason: string;         // Rejection reason (if accepted === false)
  processed: Promise<boolean>;  // Resolves when processing completes
}
```

---

## 7. Auto Instrumentation

### Overview

The SDK provides **auto-instrumentation** for popular Node.js frameworks and libraries.

### Supported Integrations

| Module | Description |
|--------|-------------|
| `HTTP` | Auto-instrument native http/https modules |
| `Express` | Middleware for Express.js |
| `Fastify` | Plugin for Fastify |
| `Axios` | HTTP client instrumentation |
| `GraphQL` | GraphQL resolver tracing |
| `Prisma` | Prisma ORM query tracing |
| `MongoDB` | MongoDB driver instrumentation |
| `Redis` | Redis client commands |
| `BullMQ` | BullMQ job queue instrumentation |
| `Global Errors` | UncaughtException/unhandledRejection |

### Usage

```javascript
import { registerAutoInstrumentations } from './instrumentation/index.js';

// Register all auto-instrumentations
registerAutoInstrumentations({
  traceAsyncHttp: true,
  captureMiddlewareSpan: true,
  captureExpressSession: true,
  instrumentMongoDB: true,
  instrumentRedis: true,
  instrumentPrisma: true,
  instrumentGraphQL: true,
  instrumentBullMQ: true
});
```

### Framework-specific Setup

```javascript
// Express middleware
import { monitorMiddleware } from './instrumentation/express.js';
app.use(monitorMiddleware);

// Fastify plugin
import fastify from 'fastify';
import { createFastifyPlugin } from './instrumentation/fastify.js';

// Prisma
import { createPrismaInstrumentation } from './instrumentation/prisma.js';
const prismaInstrumentation = createPrismaInstrumentation(prismaClient);
```

---

## 8. Feature Controller

### Overview

The FeatureController provides **plan-based feature gating** based on subscription tier.

### Usage

```javascript
const featureController = FeatureController.getInstance();

// Check if feature is enabled for current plan
if (featureController.isEnabled('errors')) {
  // Capture error
}

if (featureController.isEnabled('sessionReplay')) {
  // Enable session replay
}

// Check specific feature
const canUseProfiling = featureController.isEnabled('profiling');
```

### Plan Features

```javascript
{
  planFeatures: {
    allowBeforeSend: true,
    maxBreadcrumbs: 100,
    sampleRate: 0.5
  }
}
```

---

## 9. Transport & Queue System

### Overview

The transport system handles **event delivery** to the backend with retry logic and queue management.

### Components

- **TransportRouter**: Routes events to appropriate transport
- **Event Queue**: In-memory queue with size limits
- **Load Shedder**: Adaptive pressure-based load shedding
- **Persistence Governor**: Priority-aware persistence for crash recovery

### Usage

```javascript
import { TransportRouter } from './transport/transport-router.js';
import { eventQueue } from './transport/queue.js';

// Configure transport
const transport = TransportRouter.getInstance();
transport.configure({
  baseUrl: 'https://api.example.com',
  apiKey: 'your-api-key',
  retry: { maxAttempts: 3, backoffMs: 1000 }
});
```

---

## 10. Security & Data Scrubbing

### Overview

The SecurityScrubber provides **PII scrubbing** based on remote-config-driven rules.

### Features

- **Header Scrubbing**: Remove sensitive headers (Authorization, Cookie, etc.)
- **Body Field Scrubbing**: Mask sensitive fields (password, credit card, etc.)
- **Regex-based**: Custom regex patterns for scrubbing
- **Configurable**: Rules fetched from remote config

### Usage

```javascript
const scrubber = SecurityScrubber.getInstance();

// Scrub event
const cleanEvent = scrubber.scrub(event);

// Configure custom rules
scrubber.configure({
  scrubbing: {
    headers: ['Authorization', 'X-API-Key', 'Cookie'],
    bodyFields: ['password', 'creditCard', 'ssn', 'secret'],
    regexPatterns: ['\\b\\d{3}-\\d{2}-\\d{4}\\b']  // SSN pattern
  }
});
```

---

## Summary

The Pulse SDK implements enterprise-grade observability features:

| Feature | Implementation |
|---------|----------------|
| **Sampling** | Deterministic FNV-1a hash-based |
| **Config** | Remote fetch with hot-reload |
| **Feature Gates** | Reactive killswitches |
| **Rate Limiting** | Token bucket algorithm |
| **Multi-tenancy** | Per-tenant sliding windows |
| **Processing** | Async non-blocking pipeline |
| **Instrumentation** | Auto-patch popular frameworks |
| **Security** | Config-driven PII scrubbing |

All features support **dynamic updates** without SDK restart through the remote configuration system.