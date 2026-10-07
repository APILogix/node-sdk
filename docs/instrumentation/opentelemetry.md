# OpenTelemetry Integration & Provider Architecture

## 1. Architectural Philosophy

`@pulse-apm/node` is built upon the OpenTelemetry JavaScript SDK (`@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-metrics`, `@opentelemetry/api`). 

However, rather than exposing raw OpenTelemetry abstractions to end users, Pulse acts as an enterprise-grade orchestration layer that handles provider registration, context binding, truthful timing attribution, and self-healing recovery.

---

## 2. Singleton Provider Lifecycle

The OpenTelemetry runtime requires registering a global `TracerProvider` and `MeterProvider`:

```
                       init() Invoked
                             |
                             v
           Check if TracerProvider Registered?
                             |
              +--------------+--------------+
              |                             |
              No                           Yes
              |                             |
              v                             v
   Create NodeTracerProvider         Reuse Existing Provider
   Register BatchSpanProcessor       (Upgrade Dynamic Sampler)
   Set Global OpenTelemetry Tracer
```

### Safety Guarantees:
- **No Duplicate Providers:** Verified during adversarial testing; repeated recovery or re-initialization calls check internal registration flags and never overwrite the global `TracerProvider`.
- **Clean Shutdown:** Calling `shutdown()` invokes `provider.shutdown()`, flushing internal OpenTelemetry span processors and freeing async hooks.

---

## 3. Truthful Timing Attribution vs. Synthetic Clamping

Standard OpenTelemetry instrumentations frequently suffer from duration skew in Node.js when an event-loop stall delays the execution of a span's completion callback. Some APM vendors clamp child span durations synthetically to match their parent span's end time.

Pulse implements **Truthful Timing Attribution** ([`src/tracing/span-duration.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/span-duration.ts)):
- **Zero Synthetic Clamping:** Child spans retain their actual measured start and end timestamps.
- **Monotonic High-Resolution Timing:** Durations use `process.hrtime.bigint()` to prevent skew caused by system clock adjustments (NTP).
- **Event-Loop Lag Tolerance:** A 1.0ms event-loop jitter tolerance separates Node.js CPU execution time from database and network wait time, eliminating negative exclusive durations.
