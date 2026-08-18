SDK Remote Config — Corrected & Complete

Problems in Your Current Response

Your /v1/init response has these issues that will cause SDK validation failures:

#

Issue

Current

Required

1

Missing spans route

Not present

Required — SDK validates ALL 10 routes

2

sampling.routeOverrides is wrong key

"routeOverrides": []

Must be "routes": {} (object, not array)

3

privacy.pii wrong key

"pii": { ... }

Must be "piiDetection": { maskEmails, maskPhones, maskIPs }

4

privacy.scrubbing.enabled missing

Not present

Required boolean

5

privacy.piiDetection.maskIPs missing

Has maskCreditCards, maskPhoneNumbers

SDK expects maskEmails, maskPhones, maskIPs

6

transport.retry.enabled missing

Not present

Required boolean

7

transport.retry.backoff missing

Not present

Required: "exponential" or "linear" or "fixed"

8

transport.connections wrong shape

{ "total": 50 }

SDK expects { "maxTotalConnections": 50, "acquireTimeoutMs": 5000 }

9

entitlements section missing

Not present

Required for custom API gating

10

instrumentation wrong format

{ "http": { "enabled": true } }

SDK expects true/false OR specific config objects

11

transport.routes.*.priority is number

"priority": 1

SDK expects string: "critical", "high", "normal", "low"

Corrected Complete Response from /v1/init

This is the EXACT shape your backend should return. Every field is validated by the SDK.

{
  "success": true,
  "projectId": "16bffc54-7575-4664-9da7-542bd8b73d82",
  "organizationId": "888e933d-087d-4890-9154-0bca0b9da6c3",
  "environmentId": "6a190e10-8f49-4ed3-9a19-69bda5a5243c",
  "environment": "production",
  "configRevision": 1,
  "configHash": "344f8b9a1c5b3e29906d776ab71293024f9709973552f6a37ee4178af47aa6ed",
  "config": {
    "ingestUrl": "https://ingest.pulse.local/api/v1/events",
    "samplingRate": 1,
    "enableErrors": true,
    "enablePerformance": true,
    "maxRetries": 3,
    "maxPayloadBytes": 1048576,
    "maxQueueSize": 20000,
    "batchSize": 50,
    "flushIntervalMs": 5000
  },
  "plan": "free",
  "ingestion": {
    "endpoint": "https://ingest.pulse.local/api/v1/events",
    "batchSize": 50,
    "flushInterval": 5000,
    "maxQueueSize": 20000
  }
}

Corrected Complete Response from /v1/sdk-config

This is what POST /v1/sdk-config must return. The SDK validates this with config-validator.ts:



Field-by-Field Explanation — What Each Controls

features.* — Subsystem on/off

Field

When false

tracing

OTel tracer NOT started. span and trace events rejected. Auto-instrumentation disabled.

requestCapture

monitorMiddleware() skips capture. request events rejected.

errors

Global uncaughtException/unhandledRejection handlers NOT installed. error events rejected.

metrics

OTel meter NOT started. metric events rejected. Runtime metrics off.

logging

Logging subsystem NOT started. log events rejected. Console interception off.

profiling

Profiling subsystem NOT started. profile events rejected. startProfile() returns false.

crons

Cron subsystem NOT started. cron_checkin events rejected. Timeout tracking off.

sessionReplay

Session manager NOT started. replay events rejected.

runtimeMetrics

Adaptive memory/heap monitoring signals disabled.

eventLoopMonitoring

Event-loop lag signal disabled.

gcMonitoring

GC pressure signal disabled.

entitlements.* — Custom API billing gates

Field

When false — which API becomes no-op

customSpans

startSpan() → noop span, withSpan() → noop span, withSpanSync() → noop span

customMetrics

incrementCounter(), setGauge(), recordHistogram(), addUpDownCounter() → dropped

profiling

startProfile() → returns false immediately

logging

captureLog() → dropped

sessionReplay

captureReplay() → dropped

crons

captureCronCheckIn() → dropped

requestCapture

Auto request capture → skipped

tracing

Auto distributed tracing → skipped

errors

Auto error capture → skipped

metrics

Auto runtime metrics → skipped

sampling.* — What gets sampled

Field

Range

What it affects

traces

0.0 - 1.0

% of traces captured (by traceId hash)

requests

0.0 - 1.0

% of HTTP request events captured

errors

0.0 - 1.0

% of error events captured (usually keep at 1.0!)

profiles

0.0 - 1.0

% of CPU profiles captured

replays

0.0 - 1.0

% of replay sessions captured

metrics

0.0 - 1.0

% of metric events captured

routes

object

Per-URL-prefix overrides (e.g., silence /health completely)

transport.routes.* — Per-route delivery tuning

Field

What it controls

url

Where events of this type are POSTed

batchSize

Max events per HTTP request

flushIntervalMs

Max time to wait before sending a partial batch

timeoutMs

HTTP timeout per send

compression

"gzip" or "none"

priority

"critical" / "high" / "normal" / "low" — affects queue eviction order

killswitches.* — Emergency controls

All are boolean. When true:

disableSDK → ALL telemetry stops. Nuclear option.

disableTransport → Events queue locally but never ship. Good for "stop sending, keep collecting".

Others → specific subsystem silenced immediately.

Performance Tuning Recommendations

Route

Batch Size

Flush Interval

Why

errors

100

1000ms

Errors should arrive fast (near-real-time alerting)

events

100

2000ms

Messages are important but not urgent

traces

500

5000ms

Traces are large; batching reduces HTTP overhead

spans

500

5000ms

Same as traces (spans compose into traces)

requests

500

5000ms

High-volume; batching is essential

metrics

1000

10000ms

Metrics are aggregated anyway; large batches are efficient

logs

200

10000ms

Logs are high-volume; batch aggressively

profiles

5

30000ms

Profiles are huge (100KB+); send rarely

crons

1

0

Crons must be immediate (timeout detection depends on it)

replays

5

10000ms

Replay segments are large; batch moderately

Key principle: Lower flushIntervalMs = faster delivery but more HTTP connections. Higher batchSize = fewer connections but higher latency.

Diff: Your Original vs Corrected

Section

Your version

Corrected

Change type

sampling.routeOverrides

[] (array)

"routes": {} (object)

BREAKING — wrong type

privacy.pii

{ maskCreditCards, maskPhoneNumbers }

"piiDetection": { maskEmails, maskPhones, maskIPs }

BREAKING — wrong key names

privacy.scrubbing.enabled

missing

true

MISSING required field

transport.routes.spans

missing entirely

full route config

MISSING required route

transport.retry.enabled

missing

true

MISSING field

transport.retry.backoff

missing

"exponential"

MISSING field

transport.connections

{ total: 50 }

{ maxTotalConnections: 50, acquireTimeoutMs: 5000 }

WRONG key names

transport.routes.*.priority

numbers (1-9)

strings ("critical"/"high"/"normal"/"low")

WRONG type

entitlements

missing entirely

full object with 10 booleans

MISSING entire section

instrumentation.*

{ enabled: true } objects

true/false booleans

WRONG shape

limits.tenantGovernance

missing

full config

Missing optional section

meta.configHash

missing

present

Missing optional field

Minimal Fix Checklist for Your Backend

✅ Add spans route to transport.routes

✅ Rename sampling.routeOverrides → sampling.routes and make it an object {}

✅ Rename privacy.pii → privacy.piiDetection with fields: maskEmails, maskPhones, maskIPs

✅ Add privacy.scrubbing.enabled: true

✅ Add transport.retry.enabled: true and transport.retry.backoff: "exponential"

✅ Fix transport.connections keys: total → maxTotalConnections

✅ Change transport.routes.*.priority from numbers to strings

✅ Add entitlements section (10 booleans)

✅ Fix instrumentation.* to use true/false instead of { enabled: true/false }

✅ Add limits.tenantGovernance object (optional but recommended)

COMPLETE FIELD REFERENCE — What Each Value Does Inside the SDK

schemaVersion: 1

|---|---|| Value | SDK Behavior || 1 | SDK accepts and processes the config || > 1 | SDK REJECTS the config entirely: "SDK upgrade required". Falls back to baked-in safe defaults (all features OFF, transport killed) || Missing/invalid | SDK REJECTS: "schemaVersion is missing or not a positive integer" |

Change impact: Only change this when you make breaking schema changes. SDK won't accept configs from the future.

sdk.projectId: "16bffc54-..."

Value

SDK Behavior

Non-empty string

Stored as project identifier. Used for logging/debugging.

Empty/missing

SDK validation FAILS

Change impact: Informational only. Doesn't affect event capture behavior.

sdk.environment: "production"

Value

SDK Behavior

"production"

Attached to every event's metadata as environment field

"staging" / "development" / any string

Same — just a label on events

Empty/missing

SDK validation FAILS

Change impact: Changes the environment tag on all telemetry events. Backend can filter/route by this.

features.tracing: true

Value

SDK Behavior

true

OTel NodeTracerProvider is started. Auto-instrumentation patches HTTP/Express/Axios. Spans are created and exported. span and trace events flow through pipeline.

false

Tracer is NEVER started (or torn down on hot-reload). Auto-instrumentation removed. ALL span/trace events rejected at pipeline gate. withSpan() still runs user code but produces no telemetry.

Change impact (hot-reload): Flipping true→false tears down the tracer + removes monkey-patches. Flipping false→true re-initializes the tracer.

features.requestCapture: true

Value

SDK Behavior

true

monitorMiddleware() captures request events (URL, method, status, latency, headers, body).

false

Middleware still runs (for context propagation) but does NOT capture request events. request events rejected at pipeline.

Change impact: Stops/starts HTTP request telemetry without affecting tracing spans.

features.errors: true

Value

SDK Behavior

true

SDK installs process.on('uncaughtException') and process.on('unhandledRejection') handlers. error events flow through pipeline.

false

Global handlers are DETACHED. Uncaught errors are NOT captured by SDK. error events rejected at pipeline. Manual captureError() still works (it's a core API) but the event is dropped at the feature gate.

Change impact: Controls whether the SDK catches crashes automatically. Critical for production monitoring.

features.metrics: true

Value

SDK Behavior

true

OTel MeterProvider started. incrementCounter(), setGauge(), recordHistogram() emit events. Runtime metrics collected.

false

MeterProvider shut down. ALL metric events rejected. Custom metric APIs become silent no-ops.

Change impact: Stops all metrics collection. Reduces CPU/memory overhead.

features.logging: true

Value

SDK Behavior

true

LoggingSubsystem started. captureLog() emits log events. Console interception active (if configured).

false

LoggingSubsystem stopped. log events rejected. captureLog() is silent no-op.

Change impact: Controls structured log capture separately from captureMessage() (which is always active).

features.profiling: false

Value

SDK Behavior

true

ProfilingSubsystem started. startProfile() actually captures CPU profiles.

false

ProfilingSubsystem not started. startProfile() returns false. profile events rejected. Zero CPU overhead from profiling.

Change impact: CPU profiling has measurable overhead (~2-5% CPU). Keep false unless actively profiling.

features.crons: false

Value

SDK Behavior

true

CronSubsystem started. captureCronCheckIn() emits events. 5-minute timeout tracking active.

false

CronSubsystem not started. captureCronCheckIn() is no-op. cron_checkin events rejected. No timeout detection.

Change impact: Enables/disables cron job monitoring.

features.sessionReplay: false

Value

SDK Behavior

true

SessionManager started. captureReplay() emits replay events. Session IDs attached to all events.

false

SessionManager not started. captureReplay() is no-op. replay events rejected.

Change impact: Controls session replay capture. Note: this is NOT browser DOM recording — it captures caller-supplied segments.

features.runtimeMetrics: false

Value

SDK Behavior

true

SDK collects heap/RSS memory metrics periodically for adaptive pressure monitoring.

false

No runtime memory metrics collected. Load shedding still works but without memory pressure signals.

Change impact: Minimal overhead. Helps SDK make smarter load-shedding decisions.

features.eventLoopMonitoring: false

Value

SDK Behavior

true

SDK monitors event-loop lag. Used by adaptive pressure system to detect CPU saturation.

false

No event-loop monitoring.

Change impact: Very low overhead. Helps detect when Node.js is overwhelmed.

features.gcMonitoring: false

Value

SDK Behavior

true

SDK hooks into V8 GC events. Used for pressure detection.

false

No GC monitoring.

Change impact: Low overhead. Provides GC pressure signal.

sampling.traces: 1.0

Value

SDK Behavior

1.0

ALL traces are captured (100%)

0.5

50% of traces captured (deterministic by traceId — same trace = same decision everywhere)

0.0

NO traces captured. All dropped.

0.01

1% sampling — only 1 in 100 traces kept

Change impact: Directly controls how many span/trace events reach your backend. Lower = less data = less cost.

sampling.requests: 1.0

Value

SDK Behavior

1.0

ALL HTTP requests captured

0.1

10% of requests captured

0.0

No request events

Change impact: High-traffic apps should lower this (e.g., 0.1 = 10%). Errors are separate — you can sample requests at 10% but keep errors at 100%.

sampling.errors: 1.0

Value

SDK Behavior

1.0

ALL errors captured (recommended!)

0.5

50% of errors captured (NOT recommended — you'll miss bugs)

0.0

No errors captured

Change impact: Almost always keep at 1.0. Errors are low-volume, high-value.

sampling.profiles: 0.1

Value

SDK Behavior

0.1

10% of profile requests actually profiled

1.0

All profiles captured (expensive!)

0.0

No profiling

Change impact: Profiles are expensive (CPU overhead + large payloads). Sample aggressively.

sampling.replays: 0.1

Value

SDK Behavior

0.1

10% of sessions get replay capture

1.0

All sessions replayed

Change impact: Replay segments are large. Sample to control storage costs.

sampling.metrics: 1.0

Value

SDK Behavior

1.0

All metric events pass through

0.5

50% of metrics sampled out

Change impact: Metrics are usually aggregated — sampling below 1.0 means some data points missing.

sampling.routes: { "/health": { "traces": 0, "requests": 0 } }

Value

SDK Behavior

{} (empty)

No per-route overrides — global rates apply everywhere

{ "/health": { "traces": 0, "requests": 0 } }

Any URL starting with /health gets 0% trace/request sampling (completely silenced)

{ "/api/v1/users": { "traces": 0.5 } }

/api/v1/users routes get 50% trace sampling; other routes use global rate

Change impact: Silence noisy routes (health checks, static files) without disabling monitoring globally. Longest prefix wins.

instrumentation.http: true

Value

SDK Behavior

true

SDK patches Node.js http module to auto-create spans for outbound HTTP calls

false

No HTTP span auto-creation

Change impact: Each true adds automatic spans. More true = more telemetry = more data.

instrumentation.express: true

Value

SDK Behavior

true

SDK patches Express to create per-route spans

false

No Express auto-instrumentation

instrumentation.mongodb: false

Value

SDK Behavior

true

SDK patches MongoDB driver to create spans for queries

false

No MongoDB spans

Note: Instrumentation toggles only take effect at init time (not hot-reloadable).

privacy.capture.headers: false

Value

SDK Behavior

true

HTTP headers are INCLUDED in request events (after scrubbing)

false

Headers are NEVER attached to events — not even in redacted form

Change impact: Controls what data sections appear on events. false = safest (no data leakage possible).

privacy.capture.body: false

Value

SDK Behavior

true

Request body attached to events (after scrubbing sensitive fields)

false

Body NEVER captured — zero risk of PII leakage through bodies

privacy.scrubbing.enabled: true

Value

SDK Behavior

true

SecurityScrubber runs on every event before transport — redacts sensitive headers/fields recursively

false

NO scrubbing. Events are sent as-is. DANGEROUS — PII can leak!

Change impact: Always keep true in production!

privacy.scrubbing.headers: ["authorization", ...]

Value

SDK Behavior

Array of header names

These header names are replaced with [REDACTED] in events

Empty array

No header scrubbing (all headers pass through if capture.headers=true)

Change impact: Add any custom auth headers your app uses.

privacy.scrubbing.fields: ["password", "token", ...]

Value

SDK Behavior

Array of field names

These keys are recursively redacted in body/query/extra data

Empty array

No field scrubbing

Change impact: If your API has fields like secretKey or cvv, add them here.

privacy.piiDetection.maskEmails: true

Value

SDK Behavior

true

Email patterns (regex) in free-text fields are replaced with [email]

false

Emails pass through unmasked

privacy.piiDetection.maskPhones: true

Value

SDK Behavior

true

Phone number patterns masked with [phone]

false

Phone numbers pass through

privacy.piiDetection.maskIPs: true

Value

SDK Behavior

true

IPv4/IPv6 addresses masked with [ip]

false

IP addresses pass through

limits.maxSpansPerTrace: 2000

Value

SDK Behavior

2000

A single trace can have max 2000 spans. After that, new spans in the same trace are dropped.

500

Tighter limit — prevents trace explosion from recursive calls

5000

Max allowed by safety ceiling

Change impact: Protects against infinite loops or recursive functions creating millions of spans.

limits.maxSpanAttributes: 128

Value

SDK Behavior

128

Each span can have max 128 attributes. Additional attributes are silently dropped.

500

Max allowed by safety ceiling

limits.maxAttributeLength: 4096

Value

SDK Behavior

4096

String attribute values truncated at 4096 chars

16384

Max allowed (16KB)

Change impact: Prevents a single attribute (like a huge SQL query) from bloating event size.

limits.maxPayloadSize: 1048576

Value

SDK Behavior

1048576 (1MB)

Max size of a single HTTP batch payload. Batches are split if they exceed this.

4194304 (4MB)

Max allowed by safety ceiling

Change impact: Larger = fewer HTTP requests. Smaller = less memory per batch.

limits.maxQueueSize: 10000

Value

SDK Behavior

10000

SDK holds max 10K events in memory before dropping oldest

100000

Max allowed by safety ceiling

1000

Aggressive eviction — only 1K events buffered

Change impact: Higher = more memory usage but fewer dropped events during traffic spikes.

limits.maxMemoryMb: 256

Value

SDK Behavior

256

When process heap exceeds 256MB, SDK enters critical memory pressure mode — drops non-critical events

1024

Max allowed (1GB)

Change impact: Set to ~50% of your container's memory limit.

limits.maxCpuOverheadPercent: 5

Value

SDK Behavior

5

SDK targets max 5% CPU overhead for its own work

25

Max allowed

killswitches.disableSDK: false

Value

SDK Behavior

false

SDK operates normally

true

NUCLEAR OPTION — ALL events rejected globally. Nothing is captured or sent. SDK is completely silent.

Change impact: Use only in emergencies (SDK causing production issues). Instant effect on hot-reload.

killswitches.disableTransport: false

Value

SDK Behavior

false

Events are batched and sent to backend normally

true

Events are CAPTURED and PROCESSED but NEVER sent. They queue up locally and eventually get dropped by queue overflow. Useful for "stop sending but keep logic running".

Change impact: Good for testing or when backend is overwhelmed. Events are lost after queue fills.

killswitches.disableTracing: false

Value

SDK Behavior

false

Tracing active

true

Tracer shut down, auto-instrumentation removed, span/trace events rejected.

killswitches.disableMetrics: false

Value

SDK Behavior

false

Metrics active

true

MeterProvider shut down, metric events rejected

killswitches.disableErrors: false

Value

SDK Behavior

false

Error handlers active

true

Global error handlers detached, error events rejected

killswitches.disableProfiling: false

Value

SDK Behavior

false

Profiling active (if feature also enabled)

true

Profiler stopped, profile events rejected

killswitches.disableLogs: false

Value

SDK Behavior

false

Logging active

true

LoggingSubsystem stopped, log events rejected

transport.retry.enabled: true

Value

SDK Behavior

true

Failed HTTP sends are retried (408, 429, 5xx)

false

Failed sends are dropped immediately — no retry

transport.retry.maxRetries: 3

Value

SDK Behavior

3

Up to 3 retry attempts per batch

0

No retries at all

10

Max allowed

transport.retry.backoff: "exponential"

Value

SDK Behavior

"exponential"

Delays: 500ms → 1s → 2s → 4s (doubles each time)

"linear"

Delays: 500ms → 1000ms → 1500ms (adds base each time)

"fixed"

Delays: 500ms → 500ms → 500ms (same each time)

transport.retry.baseDelayMs: 500

Value

SDK Behavior

500

First retry waits 500ms

1000

First retry waits 1s (more conservative)

transport.queue.overflowStrategy: "drop_oldest"

Value

SDK Behavior

"drop_oldest"

When queue is full, OLDEST events are evicted to make room for new ones

"drop_newest"

When queue is full, NEW events are rejected (oldest survive)

Change impact: drop_oldest favors fresh data. drop_newest favors historical completeness.

transport.queue.criticalReserve: 1000

Value

SDK Behavior

1000

1000 queue slots are reserved for critical events (errors). Non-critical events cannot fill these slots.

0

No reservation — errors compete equally with metrics for queue space

transport.routes.errors.batchSize: 100

Value

SDK Behavior

100

Up to 100 error events per HTTP batch

1

One error per request (immediate, no batching)

500

Bigger batches, fewer requests

transport.routes.errors.flushIntervalMs: 1000

Value

SDK Behavior

1000

Send errors within 1 second even if batch isn't full

100

Near-real-time (100ms max delay)

5000

Up to 5s delay (saves HTTP connections)

transport.routes.crons.flushIntervalMs: 0

Value

SDK Behavior

0

IMMEDIATE — send cron check-in the instant it's captured (no batching delay)

Why: Cron timeout detection depends on in_progress arriving promptly. Any delay could cause false timeout alerts.

transport.routes.*.compression: "gzip"

Value

SDK Behavior

"gzip"

Batch payload is gzip-compressed before sending (50-80% smaller)

"none"

Payload sent raw (faster CPU, bigger network)

Change impact: gzip is almost always better. Use none only for crons (tiny payloads where compression overhead isn't worth it).

transport.routes.*.priority: "critical"

Value

SDK Behavior

"critical"

Queue eviction protects these events LAST (errors survive longest)

"high"

Protected after critical

"normal"

Standard eviction priority

"low"

Evicted FIRST when queue is full (metrics, profiles, replays)

transport.keepAlive: true

Value

SDK Behavior

true

HTTP connections are reused (TCP keep-alive) — fewer handshakes

false

New connection per request (wasteful)

Change impact: Always keep true in production.

runtime.configTtlSeconds: 300

Value

SDK Behavior

300

SDK re-fetches config from backend every 5 minutes

60

Refresh every minute (faster hot-reload but more backend load)

3600

Refresh every hour (minimal backend load, slower propagation)

86400

Max allowed (24h)

Change impact: Lower = faster remote control changes take effect. Higher = less load on your config endpoint.

runtime.staleWhileRevalidate: true

Value

SDK Behavior

true

If config refresh fails, SDK keeps using the last good config

false

If refresh fails, SDK resets to baked-in safe defaults (all features OFF, transport killed)

Change impact: Always keep true in production. false means a brief backend outage kills all telemetry.

entitlements.customSpans: true

Value

SDK Behavior

true

startSpan(), withSpan(), withSpanSync() create real recording spans

false

These APIs return a non-recording noop span. User code still runs normally but produces zero span telemetry.

entitlements.customMetrics: true

Value

SDK Behavior

true

incrementCounter(), setGauge(), recordHistogram(), addUpDownCounter() emit metric events

false

All custom metric calls silently dropped. Zero overhead.

entitlements.profiling: false

Value

SDK Behavior

true

startProfile() actually starts CPU profiling

false

startProfile() returns false immediately. No profiling overhead.

entitlements.logging: true

Value

SDK Behavior

true

captureLog() emits log events

false

captureLog() is silent no-op

entitlements.sessionReplay: false

Value

SDK Behavior

true

captureReplay() emits replay segment events

false

captureReplay() is silent no-op

entitlements.crons: false

Value

SDK Behavior

true

captureCronCheckIn() emits check-in events

false

captureCronCheckIn() is silent no-op

meta.generatedAt: "2026-07-29T17:12:01.313Z"

Informational — logged by SDK for debugging config age. Not validated.

meta.generatedBy: "pulse-config-compiler@1"

Informational — logged by SDK. Not validated.

meta.configHash: "344f8b9a..."

Used by ConfigManager to detect if config actually changed on refresh. If hash is same, skip re-processing.