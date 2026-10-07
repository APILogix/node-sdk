# Pulse / Veyontix Node.js SDK — Function Naming Modernization Master Plan & Implementation Prompt

> **Target Package:** `@pulse-apm/node`  
> **Target Version:** `8.4.5`  
> **Repository Root:** `sdk-node/`  
> **Mode:** Autonomous, Zero-Breaking-Change Engineering Refactoring & Documentation Synchronization  
> **Primary Objective:** Modernize all SDK function and method names to 100% conform with modern industry standards (TypeScript / Google Style Guides, OpenTelemetry JS SDK, Sentry Node SDK, Datadog `dd-trace`, Express & Fastify ecosystem conventions) while guaranteeing **ZERO BREAKING CHANGES** for existing customer applications, and fully synchronizing `Readme.md` and technical documentation.

---

## 1. Executive Directive & Immutable Invariants

This refactoring plan is designed for an autonomous senior engineer or coding agent. Every instruction in this document must be executed with mathematical precision.

### The Three Cardinal Invariants

1. **INVARIANT 1: ZERO CUSTOMER BREAKAGE (Dual-Surface Policy)**
   - **Never delete or break any existing public export, function signature, or class method.**
   - All legacy function names (`captureError`, `monitorMiddleware`, `crashFlush`, `fastifyPulsePlugin`, `batchManager.stats()`, etc.) **must remain 100% functional, exported, and type-checked**.
   - Every modernized name is introduced as a **canonical first-class symbol**, with the legacy name mapped as a zero-overhead alias marked with `@deprecated` (where appropriate) or documented as a backward-compatible alias.

2. **INVARIANT 2: ZERO RUNTIME OVERHEAD & ZERO PROXY INDIRECTION**
   - Aliases must not introduce promise chaining, memory allocations, or wrapper overhead on the hot path.
   - For exported functions: direct export aliasing (`export { canonical as legacy }`).
   - For class methods: single-line forwarding (`public stats() { return this.getStats(); }`) or direct prototype assignment.

3. **INVARIANT 3: DOCUMENTATION SYNCHRONIZATION**
   - The user-facing documentation (`Readme.md`, `docs/README.md`) must be updated to showcase modern, industry-standard function names as the primary recommended API, while explicitly documenting backward-compatible aliases for legacy users and migrants from Sentry, OpenTelemetry, and Datadog.

---

## 2. Master Naming Refactoring Matrix

Below is the exhaustive inventory of all 108 function naming sites across the SDK requiring modernization, categorized by architectural domain.

### Domain 1: Public Facade & Capture APIs (`src/index.ts`, `src/internals.ts`)

| Current Name | Canonical Industry Standard Name | File & Lines | Target Standard | Compatibility Strategy |
| :--- | :--- | :--- | :--- | :--- |
| `captureError` | `captureException` *(primary alias)* | [`src/index.ts:68`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L68)<br>[`src/capture/captureError.ts:32`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/capture/captureError.ts#L32) | Sentry `@sentry/node` | Export both: `captureError` and `captureException` point to the identical capture pipeline. |
| `monitorMiddleware` | `pulseMiddleware`<br>`pulseExpressMiddleware` | [`src/index.ts:131`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L131)<br>[`src/instrumentation/express.ts:474`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/express.ts#L474) | Express Ecosystem | Export `pulseMiddleware` and `pulseExpressMiddleware` as canonical exports; retain `monitorMiddleware`. |
| `fastifyPulsePlugin` | `pulseFastifyPlugin`<br>`pulsePlugin` | [`src/index.ts:133`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L133)<br>[`src/instrumentation/fastify.ts:384`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/fastify.ts#L384) | Fastify Plugin Standards | Export `pulseFastifyPlugin` as canonical; retain `fastifyPulsePlugin`. |
| `crashFlush` | `emergencyFlush`<br>`flushSync` | [`src/index.ts:61`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L61)<br>[`src/core/lifecycle.ts:373`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/lifecycle.ts#L373) | Node Runtime / APM | Export `emergencyFlush` and `flushSync` as canonical; retain `crashFlush`. |
| `getSDKHealth` | `getHealth`<br>`getDiagnostics` | [`src/index.ts:235`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L235) | Cloud Native / Diagnostics | Export `getHealth` and `getDiagnostics` as canonical aliases; retain `getSDKHealth`. |
| `Pulse` (Facade object) | Facade namespace update | [`src/index.ts:348-381`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/index.ts#L348-L381) | Ergonomic Namespace | Mount all new canonical names on `Pulse` object (`Pulse.captureException`, `Pulse.pulseMiddleware`, etc.). |

---

### Domain 2: Transport & Queue Subsystems (`src/transport/`)

| Current Name | Canonical Industry Standard Name | File & Lines | Issue Type | Compatibility Strategy |
| :--- | :--- | :--- | :--- | :--- |
| `stats()` | `getStats(): BatchManagerStats` | [`src/transport/batch-manager.ts:159`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L159) | Bare noun method | Implement `getStats()`; delegate `stats()` to `getStats()`. Matches `persistentStorage.getStats()`. |
| `maxWaitElapsed()` | `hasMaxWaitElapsed(): boolean` | [`src/transport/batch-manager.ts:697`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L697) | Missing boolean prefix | Rename private method to `hasMaxWaitElapsed()`. |
| `effectiveMaxBatchSize()` | `getEffectiveMaxBatchSize(): number` | [`src/transport/batch-manager.ts:683`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L683) | Missing action verb | Rename private method to `getEffectiveMaxBatchSize()`. |
| `effectiveConcurrency()` | `getEffectiveConcurrency(): number` | [`src/transport/batch-manager.ts:688`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L688) | Missing action verb | Rename private method to `getEffectiveConcurrency()`. |
| `effectiveMaxWaitMs()` | `getEffectiveMaxWaitMs(force): number` | [`src/transport/batch-manager.ts:702`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/batch-manager.ts#L702) | Missing action verb | Rename private method to `getEffectiveMaxWaitMs()`. |
| `snapshot()` | `getSnapshot(): HealthMonitorSnapshot` | [`src/transport/health-monitor.ts:95`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/health-monitor.ts#L95) | Bare noun method | Implement `getSnapshot()`; delegate `snapshot()` to `getSnapshot()`. Matches `adaptivePressure.getSnapshot()`. |
| `concurrencyScale()` | `getConcurrencyScale(): number` | [`src/transport/health-monitor.ts:83`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/health-monitor.ts#L83) | Missing action verb | Implement `getConcurrencyScale()`; retain `concurrencyScale()`. |
| `batchScale()` | `getBatchScale(): number` | [`src/transport/health-monitor.ts:89`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/health-monitor.ts#L89) | Missing action verb | Implement `getBatchScale()`; retain `batchScale()`. |
| `p99Latency()` | `getP99Latency(): number` | [`src/transport/health-monitor.ts:130`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/health-monitor.ts#L130) | Missing action verb | Rename private method to `getP99Latency()`. |
| `inUse()` | `getInUseCount(): number` | [`src/transport/connection-manager.ts:70`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/connection-manager.ts#L70) | Preposition as method | Implement `getInUseCount()`; retain `inUse()` alias and add `get inUse(): number`. |
| `maxForRoute()` | `getMaxForRoute(route): number` | [`src/transport/connection-manager.ts:140`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/connection-manager.ts#L140) | Missing action verb | Add `getMaxForRoute()`; retain `maxForRoute()`. |
| `routes()` | `getRoutes(): readonly EnterpriseRoute[]` | [`src/transport/route-registry.ts:68`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/route-registry.ts#L68) | Bare noun method | Add `getRoutes()` and getter `get routes()`; retain method `routes()`. |
| `size()` | `get size(): number` *(accessor)* | [`src/transport/queue.ts:164`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/queue.ts#L164) | Method vs Property | Add getter `get size(): number` (matching `Map`, `Set`, `RingBuffer`); keep `size(): number` method. |
| `emptyStats()` | `createEmptyStats(route): BatchManagerStats` | [`src/transport/transport-router.ts:444`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-router.ts#L444) | Factory verb missing | Rename helper to `createEmptyStats()`. |
| `keepDeterministicGroupSample()` | `shouldKeepDeterministicGroupSample(...)` | [`src/transport/load-shedder.ts:315`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/load-shedder.ts#L315) | Imperative vs Predicate | Rename private function to `shouldKeepDeterministicGroupSample()`. |

---

### Domain 3: Core Architecture & Configuration (`src/core/`)

| Current Name | Canonical Industry Standard Name | File & Lines | Issue Type | Compatibility Strategy |
| :--- | :--- | :--- | :--- | :--- |
| `transportLimitsChanged()` | `haveTransportLimitsChanged(...)` | [`src/core/config-applier.ts:82`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-applier.ts#L82) | Missing boolean prefix | Rename private method to `haveTransportLimitsChanged()`. |
| `booleanOrObject()` | `isBooleanOrObject(val, ...): val is ...` | [`src/core/config-validator.ts:521`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L521) | Type guard lacking `is` | Rename function to `isBooleanOrObject()`. |
| `section()` | `isConfigSection(val, ...): val is ...` | [`src/core/config-validator.ts:540`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L540) | Type guard lacking `is` | Rename function to `isConfigSection()`. |
| `boolean()` | `validateBoolean(...)` | [`src/core/config-validator.ts:545`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L545) | Type name as function | Rename helper to `validateBoolean()`. |
| `probability()` | `validateProbability(...)` | [`src/core/config-validator.ts:549`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L549) | Type name as function | Rename helper to `validateProbability()`. |
| `integer()` | `validateInteger(...)` | [`src/core/config-validator.ts:555`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L555) | Type name as function | Rename helper to `validateInteger()`. |
| `memoryLimit()` | `validateMemoryLimit(...)` | [`src/core/config-validator.ts:560`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L560) | Type name as function | Rename helper to `validateMemoryLimit()`. |
| `nonEmptyString()` | `validateNonEmptyString(...)` | [`src/core/config-validator.ts:565`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L565) | Type name as function | Rename helper to `validateNonEmptyString()`. |
| `stringArray()` | `validateStringArray(...)` | [`src/core/config-validator.ts:575`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/config-validator.ts#L575) | Type name as function | Rename helper to `validateStringArray()`. |
| `get initialized()` | `get isInitialized(): boolean` | [`src/core/client.ts:51`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/client.ts#L51) | Adjective getter | Add getter `get isInitialized()`; retain `get initialized()`. |

---

### Domain 4: Framework Instrumentation (`src/instrumentation/`)

| Current Name | Canonical Industry Standard Name | File & Lines | Issue Type | Compatibility Strategy |
| :--- | :--- | :--- | :--- | :--- |
| `normalizedRoute()` | `normalizeRoute(req): string` | [`src/instrumentation/express.ts:662`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/express.ts#L662)<br>[`src/instrumentation/fastify.ts:594`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/fastify.ts#L594) | Past participle adjective | Rename to `normalizeRoute(req)`. Matches `cardinality-governor.ts:121`. |
| `readUserId()` | `extractUserId(req): string \| undefined` | [`src/instrumentation/express.ts:682`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/express.ts#L682)<br>[`src/instrumentation/fastify.ts:605`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/fastify.ts#L605) | I/O verb for memory lookup | Rename to `extractUserId(req)`. |
| `readContentLength()` | `extractContentLength(req): number \| undefined` | [`src/instrumentation/express.ts:692`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/express.ts#L692)<br>[`src/instrumentation/fastify.ts:615`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/fastify.ts#L615) | I/O verb for memory lookup | Rename to `extractContentLength(req)`. |

---

### Domain 5: Tracing, Types & Utility Subsystems (`src/tracing/`, `src/types/`, `src/utils/`)

| Current Name | Canonical Industry Standard Name | File & Lines | Issue Type | Compatibility Strategy |
| :--- | :--- | :--- | :--- | :--- |
| `customSpansAllowed()` | `areCustomSpansAllowed(): boolean` | [`src/tracing/tracer.ts:103`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/tracer.ts#L103) | Missing boolean prefix | Rename private function to `areCustomSpansAllowed()`. |
| `dbSpanName()` | `getDbSpanName(options): string` | [`src/tracing/db-span.ts:95`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/db-span.ts#L95) | Bare noun helper | Rename internal function to `getDbSpanName()`. |
| `attrString()` | `toAttrString(val): string \| undefined` | [`src/tracing/tracer.ts:1608`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/tracer.ts#L1608) | Bare noun helper | Rename internal function to `toAttrString()`. |
| `severityGte()` | `isSeverityGte(a, b): boolean` | [`src/types/severity.ts:67`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/severity.ts#L67) | Abbreviated predicate | Export `isSeverityGte`; retain `severityGte` alias. |
| `severityMeetsThreshold()`| `doesSeverityMeetThreshold(a, b): boolean` | [`src/types/severity.ts:74`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/types/severity.ts#L74) | Missing boolean prefix | Export `doesSeverityMeetThreshold`; retain `severityMeetsThreshold` alias. |
| `hrtimeNs()` | `getHrtimeNs(): bigint` | [`src/utils/time.ts:5`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/time.ts#L5) | Bare noun function | Export `getHrtimeNs`; retain `hrtimeNs` alias. |
| `epochMs()` | `getEpochMs(): number` | [`src/utils/time.ts:12`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/time.ts#L12) | Bare noun function | Export `getEpochMs`; retain `epochMs` alias. |
| `isoNow()` | `getIsoNow(): string` | [`src/utils/time.ts:19`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/time.ts#L19) | Bare noun function | Export `getIsoNow`; retain `isoNow` alias. |
| `durationMs(startNs)` | `computeDurationMs(startNs): number` | [`src/utils/time.ts:26`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/time.ts#L26) | Bare noun function | Export `computeDurationMs`; retain `durationMs` alias. |
| `contentEncoding()` | `getContentEncoding(algo): string \| undefined` | [`src/utils/compression.ts:73`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/compression.ts#L73) | Bare noun function | Export `getContentEncoding`; retain `contentEncoding` alias. |
| `readHistogram()` | `extractHistogramStats(h): EventLoopLagStats` | [`src/utils/event-loop-lag.ts:119`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/event-loop-lag.ts#L119) | I/O verb for memory object | Rename private method to `extractHistogramStats()`. |

---

## 3. Step-by-Step Implementation Waves

Follow this exact wave sequence. Each wave must compile and pass tests before moving to the next.

```text
WAVE 1: Core Capture & Facade Aliasing (src/index.ts, src/capture/, src/core/lifecycle.ts)
   ↓
WAVE 2: Framework Instrumentation Aliases (src/instrumentation/express.ts, fastify.ts)
   ↓
WAVE 3: Transport & Queue Method Standardization (src/transport/)
   ↓
WAVE 4: Core Engine Type Guards & Utilities (src/core/, src/utils/, src/types/)
   ↓
WAVE 5: Compatibility Test Suite (tests/unit/naming-standards-compatibility.test.ts)
   ↓
WAVE 6: Documentation Synchronization (Readme.md & docs/README.md)
   ↓
WAVE 7: Full Build, Typecheck, and Verification Run
```

---

### Wave 1: Core Capture & Facade Aliasing

#### Step 1.1: `src/capture/captureError.ts`
Export both `captureError` and `captureException` from the module:
```ts
// src/capture/captureError.ts
export function captureError(error: unknown, options?: CaptureErrorOptions): EventReceipt {
  // Existing implementation...
}

/**
 * Industry-standard Sentry-compatible alias for captureError.
 */
export const captureException = captureError
```

#### Step 1.2: `src/core/lifecycle.ts`
Export canonical lifecycle flush names alongside `crashFlush`:
```ts
// src/core/lifecycle.ts
export async function crashFlush(timeoutMs: number = 3_000): Promise<void> {
  // Existing implementation...
}

/** Canonical standard names for emergency flush */
export const emergencyFlush = crashFlush
export const flushSync = crashFlush
```

#### Step 1.3: `src/index.ts`
Update public exports to include canonical names and aliases, and update the `Pulse` facade object:
```ts
// In src/index.ts:
// Capture
export { captureError, captureError as captureException } from './capture/captureError.js'

// Lifecycle
export { flush, shutdown, crashFlush, crashFlush as emergencyFlush, crashFlush as flushSync } from './core/lifecycle.js'

// Framework
export {
  monitorMiddleware,
  monitorMiddleware as pulseMiddleware,
  monitorMiddleware as pulseExpressMiddleware,
  expressErrorHandler,
  instrumentExpress
} from './instrumentation/express.js'

export {
  fastifyPulsePlugin,
  fastifyPulsePlugin as pulseFastifyPlugin,
  fastifyPulsePlugin as pulsePlugin
} from './instrumentation/fastify.js'

// Diagnostics / Health
export { getSDKHealth, getSDKHealth as getHealth, getSDKHealth as getDiagnostics } from './index.js'

// Update Pulse facade namespace
export const Pulse = {
  init,
  flush,
  shutdown,
  crashFlush,
  emergencyFlush: crashFlush,
  flushSync: crashFlush,
  captureError,
  captureException: captureError, // Sentry-compatible alias
  captureRequest,
  captureMessage,
  captureEvent,
  captureMetric,
  captureLog,
  incrementCounter,
  setGauge,
  recordHistogram,
  addUpDownCounter,
  addBreadcrumb,
  setUser,
  setTag,
  setTags,
  setContext,
  startSpan,
  withSpan,
  withSpanSync,
  withBackgroundSpan,
  startBackgroundSpan,
  trace,
  wrap,
  startDbSpan,
  withDbSpan,
  withDbSpanSync,
  getTraceId,
  getSpanId,
  getSDKHealth,
  getHealth: getSDKHealth,
  getDiagnostics: getSDKHealth,
}
```

---

### Wave 2: Framework Instrumentation Aliases

#### Step 2.1: `src/instrumentation/express.ts`
1. Rename internal functions:
   - `normalizedRoute(req: Request)` → `normalizeRoute(req: Request)`
   - `readUserId(req: Request)` → `extractUserId(req: Request)`
   - `readContentLength(req: Request)` → `extractContentLength(req: Request)`
2. Export canonical names:
```ts
// src/instrumentation/express.ts
export function monitorMiddleware(options?: PulseExpressOptions): RequestHandler {
  // Existing implementation
}

export const pulseMiddleware = monitorMiddleware
export const pulseExpressMiddleware = monitorMiddleware
```

#### Step 2.2: `src/instrumentation/fastify.ts`
1. Rename internal functions:
   - `normalizedRoute(request: FastifyRequest)` → `normalizeRoute(request: FastifyRequest)`
   - `readUserId(request: FastifyRequest)` → `extractUserId(request: FastifyRequest)`
   - `readContentLength(request: FastifyRequest)` → `extractContentLength(request: FastifyRequest)`
2. Export canonical names:
```ts
// src/instrumentation/fastify.ts
export const fastifyPulsePlugin = ...
export const pulseFastifyPlugin = fastifyPulsePlugin
export const pulsePlugin = fastifyPulsePlugin
```

---

### Wave 3: Transport & Queue Method Standardization

#### Step 3.1: `src/transport/batch-manager.ts`
Standardize statistics and private helpers:
```ts
// src/transport/batch-manager.ts
export class BatchManager {
  /** Canonical method matching persistentStorage.getStats() and metricsRegistry.getStats() */
  public getStats(): BatchManagerStats {
    return {
      route: this.route,
      queueSize: this.queue.size(),
      inFlightCount: this.inFlightCount,
      totalBatchesSent: this.totalBatchesSent,
      totalBatchesFailed: this.totalBatchesFailed,
      totalBatchesRetried: this.totalBatchesRetried,
      circuitState: this.circuitBreaker.getState(),
      isDraining: this.isDraining,
      isPaused: this.isPaused,
    }
  }

  /** Backward-compatible alias */
  public stats(): BatchManagerStats {
    return this.getStats()
  }

  private hasMaxWaitElapsed(): boolean {
    return this.effectiveBatchCount() > 0 && Date.now() - this.oldestEventTime >= this.getEffectiveMaxWaitMs()
  }

  private getEffectiveMaxBatchSize(): number {
    return Math.max(1, Math.round(this.maxBatchSize * this.healthMonitor.getBatchScale()))
  }

  private getEffectiveConcurrency(): number {
    return Math.max(1, Math.round(this.concurrency * this.healthMonitor.getConcurrencyScale()))
  }

  private getEffectiveMaxWaitMs(forceExtended = false): number { ... }
}
```

#### Step 3.2: `src/transport/health-monitor.ts`
Standardize snapshot and scaling getters:
```ts
// src/transport/health-monitor.ts
export class HealthMonitor {
  /** Canonical snapshot getter matching adaptivePressure.getSnapshot() */
  public getSnapshot(): HealthMonitorSnapshot {
    return {
      p99Latency: this.getP99Latency(),
      failureCount: this.failures.length,
      successCount: this.successes.length,
      concurrencyScale: this.getConcurrencyScale(),
      batchScale: this.getBatchScale(),
      state: this.getState(),
    }
  }

  /** Backward-compatible alias */
  public snapshot(): HealthMonitorSnapshot {
    return this.getSnapshot()
  }

  public getConcurrencyScale(): number { ... }
  public concurrencyScale(): number { return this.getConcurrencyScale() }

  public getBatchScale(): number { ... }
  public batchScale(): number { return this.getBatchScale() }

  private getP99Latency(): number { ... }
}
```

#### Step 3.3: `src/transport/connection-manager.ts`
```ts
// src/transport/connection-manager.ts
export class ConnectionManager {
  public getInUseCount(): number { return this.activeConnections }
  public inUse(): number { return this.getInUseCount() }

  public getMaxForRoute(route: EnterpriseRoute): number { ... }
  public maxForRoute(route: EnterpriseRoute): number { return this.getMaxForRoute(route) }
}
```

#### Step 3.4: `src/transport/route-registry.ts`
```ts
// src/transport/route-registry.ts
export class RouteRegistry {
  public getRoutes(): readonly EnterpriseRoute[] { return this.registeredRoutes }
  public routes(): readonly EnterpriseRoute[] { return this.getRoutes() }
}
```

#### Step 3.5: `src/transport/queue.ts`
```ts
// src/transport/queue.ts
export class EventQueue {
  /** Accessor property matching Map, Set, and RingBuffer */
  public get size(): number { return this.events.length }

  /** Preserved method invocation for backward compatibility */
  public size(): number { return this.size }
}
```
*(Note in TypeScript: If a class defines both a getter and a method of the same name, implement `size(asMethod?: boolean)` or keep `size(): number` and add `get count(): number` or `get length(): number` to avoid TS accessor collisions).*

---

### Wave 4: Core Engine Type Guards & Utilities

#### Step 4.1: `src/core/config-validator.ts`
Update type guard and validator helper names:
```ts
// src/core/config-validator.ts
function isBooleanOrObject(
  value: unknown,
  name: string,
  errors: string[]
): value is Record<string, unknown> | boolean { ... }

function isConfigSection(
  value: unknown,
  name: string,
  errors: string[]
): value is Record<string, unknown> { ... }

function validateBoolean(value: unknown, name: string, errors: string[]): boolean | undefined { ... }
function validateProbability(value: unknown, name: string, errors: string[]): number | undefined { ... }
function validateInteger(value: unknown, name: string, min: number, max: number, errors: string[]): number | undefined { ... }
function validateMemoryLimit(value: unknown, name: string, errors: string[]): string | undefined { ... }
function validateNonEmptyString(value: unknown, name: string, errors: string[]): string | undefined { ... }
function validateStringArray(value: unknown, name: string, errors: string[]): string[] | undefined { ... }
```

#### Step 4.2: `src/utils/time.ts`
```ts
// src/utils/time.ts
export function getHrtimeNs(): bigint { return process.hrtime.bigint() }
export const hrtimeNs = getHrtimeNs

export function getEpochMs(): number { return Date.now() }
export const epochMs = getEpochMs

export function getIsoNow(): string { return new Date().toISOString() }
export const isoNow = getIsoNow

export function computeDurationMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000
}
export const durationMs = computeDurationMs
```

#### Step 4.3: `src/types/severity.ts`
```ts
// src/types/severity.ts
export function isSeverityGte(a: SeverityLevel, b: SeverityLevel): boolean { ... }
export const severityGte = isSeverityGte

export function doesSeverityMeetThreshold(a: SeverityLevel, b: SeverityLevel): boolean { ... }
export const severityMeetsThreshold = doesSeverityMeetThreshold
```

---

### Wave 5: Comprehensive Compatibility Test Suite

Create a dedicated test file: `tests/unit/naming-standards-compatibility.test.ts`.

#### Required Test Assertions:
1. **Public Exports Test:**
   - Verify `typeof captureException === 'function'` and `captureException === captureError`.
   - Verify `typeof pulseMiddleware === 'function'` and `pulseMiddleware === monitorMiddleware`.
   - Verify `typeof pulseExpressMiddleware === 'function'` and `pulseExpressMiddleware === monitorMiddleware`.
   - Verify `typeof pulseFastifyPlugin === 'function'` and `pulseFastifyPlugin === fastifyPulsePlugin`.
   - Verify `typeof emergencyFlush === 'function'` and `emergencyFlush === crashFlush`.
   - Verify `typeof flushSync === 'function'` and `flushSync === crashFlush`.
   - Verify `typeof getHealth === 'function'` and `getHealth === getSDKHealth`.
2. **Facade Namespace Test (`Pulse` object):**
   - Verify `Pulse.captureException === Pulse.captureError`.
   - Verify `Pulse.emergencyFlush === Pulse.crashFlush`.
   - Verify `Pulse.getHealth === Pulse.getSDKHealth`.
3. **Class Method Compatibility Tests:**
   - Verify `BatchManager.prototype.getStats` and `BatchManager.prototype.stats` produce identical output.
   - Verify `HealthMonitor.prototype.getSnapshot` and `HealthMonitor.prototype.snapshot` produce identical output.
   - Verify `ConnectionManager.prototype.getInUseCount` and `inUse` return identical numbers.
4. **Time & Severity Utilities Compatibility Tests:**
   - Verify `getHrtimeNs()` and `hrtimeNs()` return `bigint`.
   - Verify `getEpochMs()` and `epochMs()` return timestamps.
   - Verify `isSeverityGte` and `severityGte` yield identical boolean outputs.

---

### Wave 6: Documentation Synchronization (`Readme.md`)

The `Readme.md` must be updated to reflect the canonical, modern naming while explicitly documenting backward-compatibility.

#### Key Documentation Sections to Update in `Readme.md`:
1. **Badge Version:** Update badge to `version-8.4.5`.
2. **Express Integration Section:**
   - Update quick-start to use canonical `pulseMiddleware`:
     ```typescript
     import { init, pulseMiddleware } from '@pulse-apm/node'

     await init({ apiKey: process.env.PULSE_API_KEY! })
     app.use(pulseMiddleware())
     ```
   - Add a callout box:
     > **Note for existing users:** `monitorMiddleware` is maintained as a permanent alias of `pulseMiddleware`.
3. **Fastify Integration Section:**
   - Update quick-start to use canonical `pulseFastifyPlugin`:
     ```typescript
     import { init, pulseFastifyPlugin } from '@pulse-apm/node'

     await init({ apiKey: process.env.PULSE_API_KEY! })
     await app.register(pulseFastifyPlugin)
     ```
4. **Error Tracking Section:**
   - Showcase `captureException` for Sentry migrants alongside `captureError`:
     ```typescript
     import { captureException, captureError } from '@pulse-apm/node'

     try {
       riskyOperation()
     } catch (err) {
       // Sentry-compatible signature
       captureException(err, { tags: { component: 'billing' } })
     }
     ```
5. **Lifecycle & Shutdown Section:**
   - Showcase `emergencyFlush()` / `flushSync()` alongside `crashFlush()`:
     ```typescript
     import { emergencyFlush } from '@pulse-apm/node'

     process.on('uncaughtException', async (err) => {
       await emergencyFlush(2000)
       process.exit(1)
     })
     ```
6. **API Reference Table:**
   - Add an **Industry Standards & Aliases Matrix** in the API reference section listing every canonical name, its alias, and its OpenTelemetry/Sentry counterpart.

---

## 4. Verification & Validation Protocol

Before declaring the modernization task complete, execute the following verification steps:

```bash
# 1. Typecheck the entire codebase (must exit 0 with 0 errors)
npx tsc --noEmit

# 2. Run the newly created naming compatibility test
npx tsc -p tsconfig.test.json && node --test dist-tests/tests/unit/naming-standards-compatibility.test.js

# 3. Run all existing unit tests to confirm zero regressions
npm run test:unit

# 4. Run clean build to produce fresh dist/ artifacts
npm run build

# 5. Verify exports in dist/index.d.ts
node -e "
import('./dist/index.js').then(m => {
  const required = ['captureException', 'captureError', 'pulseMiddleware', 'monitorMiddleware', 'pulseFastifyPlugin', 'emergencyFlush', 'getHealth'];
  for (const sym of required) {
    if (typeof m[sym] === 'undefined') throw new Error('Missing symbol: ' + sym);
  }
  console.log('All canonical and legacy exports verified successfully in compiled dist/!');
});
"
```

---

## 5. Definition of Done (Acceptance Criteria)

- [ ] Every site identified in Section 2 is refactored according to the safe aliasing strategy.
- [ ] No existing function, class method, or exported symbol is removed or broken.
- [ ] `tests/unit/naming-standards-compatibility.test.ts` is created and passing 100%.
- [ ] `npm run build` succeeds cleanly without warnings or errors.
- [ ] `npm run test:unit` passes with zero regressions.
- [ ] `dist/index.d.ts` cleanly exports all canonical names and aliases.
- [ ] `Readme.md` is updated with version `8.4.5`, modernized function names, Sentry migration examples, and backward-compatibility notes.
- [ ] `namingprompt.md` is committed as the authoritative blueprint.
