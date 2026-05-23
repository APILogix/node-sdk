# Pulse SDK v2.0.0 — OpenTelemetry Migration Analysis

**Objective:** Determine what should move to OTel, what stays custom, and what becomes hybrid.  
**Principle:** OTel should own **standards**, SDK should own **value-add**.

---

## 1. Executive Summary

The Pulse SDK currently operates in a **hybrid state** — it uses OpenTelemetry APIs for tracing and metrics, but wraps them with custom infrastructure. The migration to a cleaner architecture requires **three strategic moves**:

1. **Move to OTel** (standardizabile, commoditized):
   - Instrumentation (HTTP, Express)
   - Trace propagation (W3C headers)
   - Resource detection
   - Samplers
   - Semantic conventions

2. **Stay Custom** (differentiated, business-critical):
   - Transport layer (retry, batching, circuit breaker)
   - Feature gating (plan enforcement)
   - Error deduplication
   - Plugin system
   - Breadcrumbs

3. **Become Hybrid** (OTel base + SDK enrichment):
   - Span processing (OTel creates, SDK enriches)
   - Metric export (OTel collects, SDK transports)
   - Context (OTel propagates, SDK adds business context)

---

## 2. Current OTel Integration Map

```
┌─────────────────────────────────────────────────────────────┐
│              CURRENT ARCHITECTURE (Hybrid)                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐      ┌─────────────────┐            │
│  │  OTel API       │      │  Custom SDK      │            │
│  │  (tracer,       │      │  (client, queue,  │            │
│  │   metrics,      │─────→│   batcher,       │            │
│  │   context)      │      │   transport)     │            │
│  └─────────────────┘      └─────────────────┘            │
│         │                         │                       │
│         ▼                         ▼                       │
│  ┌─────────────────┐      ┌─────────────────┐            │
│  │  NodeTracer      │      │  EventPipeline  │            │
│  │  Provider        │      │  (normalize,    │            │
│  │                 │      │   sanitize,      │            │
│  │                 │      │   enrich, queue) │            │
│  └─────────────────┘      └─────────────────┘            │
│         │                         │                       │
│         └───────→───────┬──────────┘                       │
│                         ▼                                │
│              ┌─────────────────┐                         │
│              │  PulseMetric    │                         │
│              │  Reader (custom)│                         │
│              └─────────────────┘                         │
│                         │                                │
│                         ▼                                │
│              ┌─────────────────┐                         │
│              │  Event Queue    │                         │
│              │  → Batch        │                         │
│              │  → HTTP Send    │                         │
│              └─────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│           TARGET ARCHITECTURE (Clean OTel + SDK)           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────┐   ┌─────────────────────────┐ │
│  │   OPENTELEMETRY LAYER   │   │   PULSE SDK LAYER       │ │
│  │  (Standards, Commoditized)│   │  (Value-Add, Custom)   │ │
│  ├─────────────────────────┤   ├─────────────────────────┤ │
│  │ • NodeTracerProvider    │   │ • Client Singleton       │ │
│  │ • Auto-Instrumentation  │   │ • Feature Gates          │ │
│  │ • W3C Propagation       │   │ • Plan Enforcement       │ │
│  │ • Resource Detection    │   │ • Error Deduplication    │ │
│  │ • Samplers              │   │ • Plugin System          │ │
│  │ • Semantic Conventions    │   │ • Breadcrumbs            │ │
│  │ • OTLP Exporter (future) │  │ • Transport (Retry, CB)  │ │
│  └─────────────────────────┘   │ • Persistent Storage     │ │
│              │                  │ • Ingest Pipeline          │ │
│              │                  └─────────────────────────┘ │
│              │                         ▲                   │
│              │                         │                   │
│              ▼                         │                   │
│  ┌─────────────────────────┐           │                   │
│  │  PulseSpanProcessor     │───────────┘                   │
│  │  (Bridge: OTel → SDK)   │                               │
│  │  • Receives OTel spans  │                               │
│  │  • Routes to EventPipeline│                             │
│  │  • Adds SDK enrichments │                               │
│  └─────────────────────────┘                               │
│                                                            │
│  ┌─────────────────────────┐                               │
│  │  PulseMetricExporter    │                               │
│  │  (Bridge: OTel → SDK)   │                               │
│  │  • Receives OTel metrics │                               │
│  │  • Routes to EventPipeline│                             │
│  └─────────────────────────┘                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Migration Plan

### 4.1 Phase 1: Foundation (Week 1-2)

#### 4.1.1 Move: Auto-Instrumentation → Pure OTel

**Current:** Custom wrapper around OTel instrumentations
**Target:** Register OTel instrumentations directly, no custom wrapper

```typescript
// BEFORE (custom wrapper)
export function registerAutoInstrumentations(options: AutoInstrumentOptions): void {
  if (instrumented) return
  instrumented = true
  // ...custom guard logic, manual ignoreOutgoingRequestHook, etc.
  registerInstrumentations({ instrumentations: [...] })
}

// AFTER (pure OTel)
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

const instrumentations = getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-http': { /* config */ },
  '@opentelemetry/instrumentation-express': { /* config */ },
  // SDK's own ingore-url logic becomes OTel filter
})
registerInstrumentations({ instrumentations })
```

**Benefits:**
- Remove 114 lines of custom instrumentation wrapper
- Standard OTel behavior, better tested
- Automatic span correlation with other OTel libraries

**Risks:**
- Lose custom `ignoreOutgoingRequestHook` (ingest URL guard) → Add as OTel `ignoreOutgoingRequestUrl` config

---

#### 4.1.2 Move: Resource Detection → OTel Resource Detectors

**Current:** Custom `detectResources()` in `utils/resource-detector.ts`
**Target:** Use `@opentelemetry/resource-detector-*` packages

```typescript
// BEFORE
const resources = detectResources(client.metadata.sdkVersion)

// AFTER
import { envDetector } from '@opentelemetry/resources'
import { processDetector } from '@opentelemetry/resources'
import { awsEc2Detector } from '@opentelemetry/resource-detector-aws'

const resource = await detectResources({
  detectors: [envDetector, processDetector, awsEc2Detector],
})
```

**Benefits:**
- More resource attributes (cloud, k8s, container)
- Standard semantic conventions
- Community-maintained detectors

---

### 4.2 Phase 2: Tracing (Week 3-4)

#### 4.2.1 Move: Trace Propagation → OTel Propagation API

**Current:** Custom `context-propagation.ts` with manual header parsing
**Target:** OTel `PropagationAPI` with `W3CTraceContextPropagator`

```typescript
// BEFORE
export function extractTraceContext(headers: Record<string, string>): Context {
  return propagation.extract(otelContext.active(), headers, headerGetter)
}

// AFTER (already using OTel, but own the whole flow)
import { propagation, W3CTraceContextPropagator } from '@opentelemetry/core'

const propagator = new W3CTraceContextPropagator()
propagator.extract(context, carrier, getter)
```

**Benefits:**
- Remove 175 lines of custom propagation code
- Standard OTel behavior
- Automatic propagation through all instrumented libraries

---

#### 4.2.2 Hybrid: Span Processing → `PulseSpanProcessor`

**Current:** `PipelineSpanExporter` implements `SpanExporter`
**Target:** `PulseSpanProcessor` extends `SpanProcessor`

```typescript
// BEFORE
class PipelineSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], callback: (result) => void) {
    for (const span of spans) {
      processEvent(this.spanToEvent(span)) // Custom conversion
    }
  }
}

// AFTER
class PulseSpanProcessor extends SpanProcessor {
  onEnd(span: ReadableSpan) {
    const sdkEvent = spanToEvent(span)
    // SDK enrichment: add breadcrumbs, scope, user context
    enrichEvent(sdkEvent)
    processEvent(sdkEvent)
  }
}
```

**Benefits:**
- Proper OTel `SpanProcessor` lifecycle (onStart, onEnd, shutdown)
- Access to span context during processing
- Standard OTel shutdown (flush pending spans)

---

### 4.3 Phase 3: Metrics (Week 5-6)

#### 4.3.1 Fix: Histogram Percentile Computation

**Current:** Linear interpolation between min and max (mathematically wrong)
**Target:** Use OTel's exponential histogram bucket counts

```typescript
// BEFORE (incorrect)
function computePercentile(p: number, min: number, max: number, count: number) {
  const rank = (p / 100) * (count - 1)
  return min + (rank / (count - 1)) * (max - min)
}

// AFTER (correct, using bucket counts)
function computePercentile(
  p: number,
  positiveBuckets: { offset: number, counts: number[] },
  scale: number
): number {
  // Find bucket containing rank
  const totalCount = sum(positiveBuckets.counts)
  const rank = Math.floor((p / 100) * totalCount)
  
  let cumulative = 0
  for (let i = 0; i < positiveBuckets.counts.length; i++) {
    cumulative += positiveBuckets.counts[i]
    if (cumulative >= rank) {
      // Interpolate within bucket
      const bucketStart = base ^ (offset + i) / 2^scale
      const bucketEnd = base ^ (offset + i + 1) / 2^scale
      return bucketStart + (rank - (cumulative - positiveBuckets.counts[i])) / 
             positiveBuckets.counts[i] * (bucketEnd - bucketStart)
    }
  }
}
```

---

#### 4.3.2 Move: Metric Aggregation → OTel Views

**Current:** Custom `PulseMetricReader` with manual aggregation
**Target:** OTel Views with custom aggregation selection

```typescript
// AFTER (using OTel Views)
const view = new View({
  name: 'request.duration',
  aggregation: new ExplicitHistogramAggregation([5, 10, 25, 50, 100, 250, 500, 1000]),
})

const meterProvider = new MeterProvider({
  views: [view],
})
```

---

### 4.4 Phase 4: Sampling (Week 7)

#### 4.4.1 Move: Sampling → OTel Sampler

**Current:** Custom deterministic hash-based sampler in `event-pipeline.ts`
**Target:** OTel `ParentBasedSampler` with `TraceIdRatioBasedSampler`

```typescript
// BEFORE
function shouldSample(rate: number, traceId?: string): boolean {
  if (traceId) {
    const hash = deterministicHash(traceId)
    return hash < rate
  }
  return Math.random() < rate
}

// AFTER
import { TraceIdRatioBasedSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base'

const sampler = new ParentBasedSampler({
  rootSampler: new TraceIdRatioBasedSampler(0.5),
})
```

**Benefits:**
- Standard OTel sampling
- Automatic parent-based sampling
- Configurable per-span, per-trace, or per-service

---

## 5. Migration Risk Matrix

| Feature | Migration Complexity | Risk Level | Business Impact | Priority |
|---------|-------------------|------------|----------------|----------|
| Auto-Instrumentation | Low | Low | High | P1 |
| Resource Detection | Low | Low | Medium | P2 |
| Trace Propagation | Medium | Medium | High | P1 |
| Span Processing | Medium | High | High | P1 |
| Histogram Computation | High | High | High | P0 |
| Metric Aggregation | Medium | Medium | Medium | P2 |
| Sampling | Low | Low | High | P1 |

---

## 6. Long-Term Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              PULSE SDK v3.0 (Target State)                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  LEGEND:                                                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │  PURE OTEL  │ │   HYBRID    │ │      PULSE CUSTOM       │ │
│  │  (moved)    │ │  (bridge)   │ │      (stays)            │ │
│  └─────────────┘ └─────────────┘ └─────────────────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ OpenTelemetry Node SDK                                  │ │
│  │ • NodeTracerProvider                                     │ │
│  │ • Auto-Instrumentations                                  │ │
│  │ • W3C Propagation                                        │ │
│  │ • Resource Detectors                                     │ │
│  │ • Samplers                                               │ │
│  │ • Semantic Conventions                                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                         │                                   │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ PulseSpanProcessor (HYBRID)                              │ │
│  │ • Receives OTel spans                                     │ │
│  │ • Adds SDK enrichment (user, tags, breadcrumbs)          │ │
│  │ • Routes to EventPipeline                                 │ │
│  └─────────────────────────────────────────────────────────┘ │
│                         │                                   │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ EventPipeline (PULSE CUSTOM)                             │ │
│  │ • Normalize, Sanitize, Enrich                           │ │
│  │ • Deduplicate, Sample, Plugin Process                   │ │
│  │ • Queue & Persist                                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                         │                                   │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Transport Layer (PULSE CUSTOM)                           │ │
│  │ • Batching, Retry Budget, Circuit Breaker               │ │
│  │ • Rate Limiting, Compression, HTTP Transport              │ │
│  │ • Persistent Storage                                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Timeline & Effort Estimates

| Phase | Duration | Effort | Key Deliverable |
|-------|----------|--------|----------------|
| 1. Foundation | 2 weeks | 1 engineer | OTel instrumentations, resource detection |
| 2. Tracing | 2 weeks | 1 engineer | `PulseSpanProcessor`, context propagation |
| 3. Metrics | 2 weeks | 1 engineer | Fixed histograms, OTel Views |
| 4. Sampling | 1 week | 0.5 engineer | OTel Sampler integration |
| 5. Integration Testing | 2 weeks | 1 engineer | End-to-end validation |
| **Total** | **9 weeks** | **3.5 engineer-months** | **v3.0 OTel-native SDK** |

---

## 8. Key Success Metrics

| Metric | Before | After (Target) |
|--------|--------|----------------|
| Lines of custom instrumentation code | 114 | 0 |
| Histogram percentile accuracy | ❌ Incorrect | ✅ Correct |
| Context propagation | Manual | Automatic (OTel) |
| Span shutdown (flush) | Custom | Standard OTel |
| Metric aggregation | Custom reader | OTel Views |
| Sampling | Custom hash | OTel Sampler |

---
