You are a principal staff engineer and distributed systems architect.

Your task is to build an enterprise-grade observability SDK platform from scratch using modern industry standards.

The platform combines:

tracing
logging
metrics
profiling
ingestion pipeline
retry systems
batching systems
offline persistence
distributed context propagation
dynamic remote config
plugin architecture
enterprise security
scalable ingestion APIs

The system must rival enterprise platforms.

The architecture must prioritize:

scalability
reliability
throughput
fault tolerance
security
extensibility
low overhead
async performance
developer experience
modularity
standards compliance

You MUST use OpenTelemetry wherever it is the industry-standard solution.

You MUST build custom systems only where OpenTelemetry does not fully solve the problem.

CORE ARCHITECTURE RULES

The system MUST follow:

clean architecture
domain-driven design
hexagonal architecture
SOLID principles
event-driven architecture
plugin-first design
modular SDK packages
dependency inversion
enterprise folder structure
strict typing
immutable core events
async-first execution
zero shared mutable state
graceful degradation

Never build a monolith.

Everything must be modular.

PRIMARY STACK

SDK STACK:

TypeScript
Node.js
OpenTelemetry SDK
AsyncLocalStorage

zod
pino
msgpack
gzip/brotli
worker_threads

INGESTION STACK:

Node.js
Fastify

QUEUE STACK:

BullMQ

SDK DESIGN GOALS

The SDK MUST:

have extremely low overhead
avoid blocking the event loop
support millions of events
support distributed systems
work in microservices
support edge runtimes
support serverless
support monorepos
support worker processes
support clustered applications
support offline environments
support flaky networks
PACKAGE STRUCTURE

Design the SDK as separate packages.

Required packages:

core
tracing
logging
metrics
profiling
exporters
transport
queue
plugins
instrumentation
security
config
offline
integrations
utils

Each package must be independently versioned.

OPEN TELEMETRY REQUIREMENTS

Use OpenTelemetry for:

distributed tracing
spans
trace propagation
async context tracking
instrumentation hooks
metrics
semantic conventions
exporters
baggage propagation

Use native OpenTelemetry APIs wherever possible.

Never reinvent tracing primitives already provided by OpenTelemetry.

AUTO INSTRUMENTATION

Implement enterprise-grade automatic instrumentation.

The SDK MUST automatically capture:

incoming HTTP requests
outgoing HTTP requests
HTTP responses
GraphQL requests
WebSocket events
DB queries
ORM operations
Redis operations
Kafka operations
RabbitMQ operations
queue jobs
cron jobs
serverless invocations
external API calls
cache operations
filesystem operations
worker thread activity

Supported frameworks:

Express
Fastify
NestJS
Koa
Hapi
Next.js
Remix
React SSR
Apollo GraphQL

Supported databases:

PostgreSQL
MySQL
MongoDB
Redis
Elasticsearch

Supported ORMs:

Prisma
TypeORM
Sequelize
Mongoose
Drizzle

Instrumentation requirements:

automatic patching
safe monkey patching
patch isolation
duplicate patch prevention
hot reload compatibility
ESM support
CommonJS support
lazy loading support
runtime detection
safe shutdown cleanup
DISTRIBUTED TRACING

Build full enterprise tracing.

Features required:

traces
spans
nested spans
parent-child spans
linked spans
async context propagation
cross-service correlation
trace state
baggage propagation
distributed transactions
partial trace recovery
orphan span handling

Trace capabilities:

trace sampling
dynamic sampling
adaptive sampling
tail-based sampling
head-based sampling

Implement:

trace IDs
span IDs
correlation IDs
request IDs

Must support W3C Trace Context.

Support:

traceparent
tracestate
baggage

Must support:

OpenTelemetry propagation
B3 propagation
Jaeger propagation
CONTEXT PROPAGATION

Implement robust async context management.

Use:

AsyncLocalStorage
OpenTelemetry Context APIs

Context propagation must survive:

promises
async await
timers
queues
worker threads
nested callbacks
streams
message queues

Context must never leak across requests.

Implement automatic correlation:

logs ↔ traces
metrics ↔ traces
errors ↔ traces
ERROR TRACKING

Build enterprise-grade error capture.

Capture:

uncaught exceptions
unhandled rejections
async errors
HTTP failures
DB failures
worker crashes
process crashes

Capture metadata:

stack traces
source maps
release versions
git commit SHA
deployment environment
request context
user context
runtime context
memory state
breadcrumbs

Implement:

source map symbolication
stack frame parsing
code frame extraction
fingerprinting
issue grouping
duplicate suppression

Support:

Node.js
Browser
Serverless

Implement error severity:

fatal
error
warning
info
LOGGING SDK

Build a structured logging engine.

Requirements:

structured logs
JSON logs
correlated logs
trace-aware logs
async-safe logging
log batching
log enrichment
contextual logging

Support log levels:

trace
debug
info
warn
error
fatal

Features:

automatic metadata enrichment
redaction
masking
PII stripping
trace correlation
request correlation
child loggers
log sampling

Integrate with:

pino
winston
bunyan

Provide custom logger.

METRICS SDK

Use OpenTelemetry Metrics SDK.

Support:

counters
gauges
histograms
summaries
up-down counters

Support aggregation:

percentile aggregation
latency histograms
SLA buckets
custom buckets

Metrics required:

request count
latency
throughput
queue depth
retry count
memory usage
CPU usage
event loop lag
error rate
GC pauses

Export formats:

OTLP
Prometheus
StatsD
PROFILING SYSTEM

Build a low-overhead profiler.

Capture:

CPU usage
memory usage
heap snapshots
event loop lag
GC pauses
slow functions
async bottlenecks

Features:

statistical profiling
sampled profiling
continuous profiling
flamegraphs
hotspot detection

Requirements:

minimal overhead
adaptive sampling
production-safe profiling
automatic pause under high load
OFFLINE QUEUE SYSTEM

Build enterprise offline persistence.

Requirements:

disk buffering
retry persistence
reconnect flushing
crash-safe writes
corruption recovery

Storage requirements:

append-only storage
WAL design
compaction
checksum validation
queue replay

Features:

priority queues
event deduplication
persistent retries
replay protection

Must survive:

process crashes
machine reboots
network failures
RETRY SYSTEM

Build resilient retry architecture.

Features:

exponential backoff
retry jitter
retry caps
retry budgets
retry persistence
adaptive retry

Support retry policies:

linear
exponential
decorrelated jitter
Fibonacci

Requirements:

avoid retry storms
circuit breakers
bulkhead isolation
backpressure awareness
BATCHING ENGINE

Build advanced batching.

Requirements:

size-based flushing
time-based flushing
adaptive batching
compression
streaming uploads

Compression:

gzip
brotli
msgpack

Features:

queue-aware batching
priority batching
memory-safe batching
partial batch retries
SAMPLING SYSTEM

Implement advanced sampling.

Support:

fixed sampling
probabilistic sampling
adaptive sampling
dynamic sampling
error-priority sampling
endpoint-aware sampling

Requirements:

runtime reconfiguration
remote-controlled sampling
tenant-aware sampling
DYNAMIC CONFIG SYSTEM

Build remote config infrastructure.

Features:

feature toggles
instrumentation toggles
sampling updates
exporter updates
runtime overrides

Requirements:

polling
websocket updates
ETag caching
local fallback
rollback support

Must support:

tenant-specific config
environment config
staged rollout
canary rollout
PLUGIN SYSTEM

Design plugin-first SDK architecture.

Plugins can provide:

middleware
enrichers
filters
exporters
processors
transformers

Requirements:

sandboxing
lifecycle hooks
plugin isolation
dependency injection
runtime loading
hot reload support

Plugin hooks:

beforeSend
afterSend
beforeExport
beforeRetry
beforeFlush
beforeSpanEnd
SECURITY REQUIREMENTS

Implement enterprise security.

Requirements:

API key validation
signed payloads
payload hashing
encryption
TLS enforcement
payload integrity
replay protection

Implement:

HMAC signatures
nonce validation
timestamp validation
rotating secrets

PII protection:

automatic masking
regex masking
schema masking
custom masking rules

Sensitive fields:

passwords
tokens
auth headers
cookies
payment data
session IDs

Implement compliance support:

GDPR
SOC2
HIPAA-ready architecture
INGESTION API

Build high-throughput ingestion APIs.

Requirements:

async ingestion
streaming ingestion
chunked uploads
compressed payloads
multi-tenant ingestion
high concurrency

API stack:

Fastify
HTTP2
keep-alive
streaming parsers

Support:

OTLP
JSON
protobuf
msgpack

Features:

schema validation
payload normalization
deduplication
idempotency
QUEUE SYSTEM

Build enterprise queue pipelines.

Queues required:

ingestion queue
processing queue
retry queue
DLQ

Requirements:

Kafka support
Redis Streams support
BullMQ support

Features:

retry orchestration
poison message detection
replay tooling
dead-letter replay
queue prioritization
STORAGE ARCHITECTURE

Tracing storage:

ClickHouse

Logs storage:

ClickHouse
Loki

Metrics storage:

Prometheus
ClickHouse

Cold storage:

S3

Metadata storage:

PostgreSQL

Requirements:

partitioning
TTL policies
retention management
indexing
compaction
EXPORTER SYSTEM

Build exporters for:

OTLP
Jaeger
Zipkin
Kafka
Prometheus
Loki
Elasticsearch
S3

Requirements:

backpressure support
retry awareness
offline buffering
compression support
PERFORMANCE REQUIREMENTS

The SDK overhead must remain:

under 5ms p95
minimal heap allocation
no event loop blocking
low memory overhead

Benchmark requirements:

100k events/sec
million-span workloads
burst traffic handling
RESILIENCE REQUIREMENTS

Implement:

graceful degradation
circuit breakers
backpressure protection
memory pressure handling
queue overflow protection

The SDK must never crash the host application.

MULTI TENANCY

Support:

tenant isolation
tenant quotas
tenant rate limiting
tenant configs
tenant retention policies
RATE LIMITING

Implement:

token bucket
sliding window
distributed rate limiting

Protect:

ingestion APIs
exporters
retry systems
BACKPRESSURE CONTROL

Implement:

queue throttling
adaptive dropping
priority dropping
sampling escalation

Critical telemetry must survive.

RELEASE ENGINEERING

Implement:

semantic versioning
automated releases
changelog generation
canary releases
TESTING REQUIREMENTS

Testing required:

unit tests
integration tests
e2e tests
chaos tests
load tests
stress tests
fuzz testing

Coverage target:

90%+
LOAD TESTING

Simulate:

million requests
retry storms
queue overflow
network outages
Kafka outages
Redis outages
ClickHouse outages
DOCUMENTATION REQUIREMENTS

Generate:

architecture docs
sequence diagrams
API docs
SDK docs
integration guides
deployment guides
troubleshooting guides
DEVEX REQUIREMENTS

Provide:

excellent TypeScript types
autocomplete
IDE hints
runtime validation
developer warnings
migration tooling
CONFIGURATION SYSTEM

Support:

environment variables
JSON config
YAML config
runtime config
remote config

Validation via zod.

SDK PUBLIC API

The SDK API must be:

ergonomic
chainable
typed
minimal
extensible

Example:

const sdk = createSDK({
  apiKey: process.env.API_KEY,
  service: "payments-service",
  tracing: true,
  metrics: true,
  logging: true,
});
ENTERPRISE FEATURES

Support:

multi-region ingestion
failover routing
geo routing
regional buffering
disaster recovery
KUBERNETES SUPPORT

Provide:

Helm charts
autoscaling
readiness probes
liveness probes
HPA configs
pod disruption budgets
AI AGENT EXECUTION RULES

You MUST:

implement features incrementally
commit after each stable milestone
generate production-ready code only
avoid placeholders
avoid TODOs
avoid mock implementations
include validation everywhere
include logging everywhere
include telemetry everywhere
include tests everywhere

For every module:

design architecture
define interfaces
implement types
implement validations
implement business logic
add observability
add retries
add tests
add benchmarks
add documentation

Never skip steps.

CODE QUALITY RULES

Every file MUST:

have strict typing
avoid any
avoid global mutable state
avoid silent failures
use exhaustive error handling
FAILURE HANDLING

Every async operation MUST:

timeout
retry safely
emit telemetry
support cancellation

Use AbortController everywhere.

FINAL GOAL

Build a production-grade observability platform capable of competing with:

OpenTelemetry
Datadog
New Relic
Sentry
Honeycomb
Grafana Cloud

The final system must support:

massive scale
enterprise security
distributed systems
microservices
serverless
offline environments
multi-region deployments

Every subsystem must be production hardened.

Never implement toy solutions.