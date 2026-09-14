# SDK Node Cubicle Raw Telemetry Analysis & Observability Platform — Engineering Report

**Target Repository:** `sdk-node`  
**Monitored Application:** `cubicle-be` (`paypalproject`, Express 5.x)  
**SDK Package:** `@pulse-apm/node` (v8.1.2 captured runtime / v8.3.12 codebase)  
**Analyzed Artifact Directory:** `sdk-node/cubicle/`  
**Platform URL:** `http://localhost:3300/index.html`  
**Automated Tests:** `node --test sdk-node/observability-platform/tests/engine.test.js` (9/9 PASS)

---

## Executive Summary

An exhaustive forensic analysis was performed on all **4,219 raw files** inside `sdk-node/cubicle`. A deterministic, mathematically accurate telemetry reconstruction engine was built in `sdk-node/observability-platform/engine/`. The engine correlates all inbound HTTP requests, distributed traces, nested spans, database queries, structured logs, and errors without fabricating or inferring unsupported relationships.

A multi-page HTML observability platform was constructed in `sdk-node/observability-platform/ui/`, featuring an interactive timeline waterfall with microsecond precision, a 5-tab span detail drawer, deep cross-entity navigation, global search, data provenance, and automated diagnostic checks.

---

## A. Cubicle Inventory

The `sdk-node/cubicle/` directory contains exactly **4,219 JSON files** across 7 subdirectories:

| Directory | File Count | Format | Primary Content |
| :--- | :--- | :--- | :--- |
| `cubicle/raw_batches/` | **253** | JSON | Intercepted HTTP batch export payloads sent by the SDK exporter to backend routes (`/traces`, `/spans`, `/requests`, `/errors`, `/logs`). |
| `cubicle/spans/` | **2,106** | JSON | Standalone database command spans (`$cmd`, `createIndexes`, `create`, `saslStart`, `saslContinue`). |
| `cubicle/traces/` | **1,836** | JSON | Trace summaries containing embedded `rootSpan` and nested `children` trees (yielding 2,154 nested span instances). |
| `cubicle/requests/` | **16** | JSON | Inbound Express HTTP request performance records with route, latency, status code, IP, headers, and query parameters. |
| `cubicle/errors/` | **3** | JSON | Individual error records (2 handled SSL warnings, 1 fatal unhandled crash). |
| `cubicle/logs/` | **2** | JSON | Structured application logs emitted via `console.error`. |
| `cubicle/init/` | **3** | JSON | Captured `/v1/init` handshake requests containing SDK client headers and API key authorization. |
| **Total** | **4,219** | **JSON** | **Zero corrupted files (100% valid JSON).** |

---

## B. Telemetry Types & Event Categories

1. **HTTP Inbound Requests (16 events):**
   - Routes: `/api/firm/getAllFirm`, `/api/organization/settings/`, `/api/workspace/my-workspace/all`, `/api/auth/refresh`, `/api/auth/signin`, `/api/me/permissions`.
   - Latencies: 5ms to 30,097ms (bimodal: fast unauthorized 401s vs long database timeouts/retries).
2. **Distributed Traces (1,778 unique trace IDs):**
   - **16 multi-span traces** (18 to 44 spans each) representing incoming HTTP requests with middleware execution chains.
   - **1,762 standalone traces** (1 span each) representing background/startup MongoDB indexing commands (`createIndexes`, `create`, `saslStart`).
3. **Spans (2,107 unique spans across the dataset):**
   - `kind: "server"`: **16 spans** (Express request root spans).
   - `kind: "internal"`: **288 spans** (Express middlewares: `query`, `jsonParser`, `corsMiddleware`, `apiActivityTracker`, router handlers, and Prisma client transactions).
   - `kind: "client"`: **1,803 spans** (Mongoose queries: `User.findOne`, `RolePermission.find`, MongoDB driver commands, and PostgreSQL connection pool handshakes: `pg-pool.connect`, `pg.connect`).
4. **Database Operations (1,814 captured operations):**
   - **MongoDB Native Driver & Mongoose:** 1,794 operations.
   - **Prisma Client Operations:** 12 operations (`prisma:client:transaction`, `prisma:client:connect`, etc.).
   - **PostgreSQL Driver (`pg-pool`):** 8 operations.
5. **Errors & Exceptions (3 events in 2 distinct fingerprint groups):**
   - Handled Warning (`Error`, `console.error`): `(node:15544) Warning: SECURITY WARNING: The SSL modes...` (2 occurrences, routes `/api/auth/refresh` and `/api/auth/signin`).
   - Fatal Crash (`TypeError`, `uncaughtException`): `Cannot read properties of undefined (reading 'catch')` in `apiActivityTracker.js:24:7` during `GET /api/me/permissions`.
6. **Structured Logs (2 events):**
   - `level: "error"` correlated to the SSL deprecation warning emitted by the pg driver.
7. **SDK Init Events (3 events):**
   - POST `/v1/init` with `x-api-key: pv_live_943f26c296276b305f6ac2ff...`.

---

## C. Data Model & Entity Correlation

The platform correlates the telemetry entities via a deterministic multi-way graph:

```
                  ┌──────────────────────┐
                  │    HTTP Request      │
                  │  (requestId, 16 reqs)│
                  └──────────┬───────────┘
                             │ traceId & spanId
                             ▼
┌──────────────┐  traceId ┌──────────────────────┐  traceId ┌──────────────┐
│  Error Event │ ◄─────── │        Trace         │ ───────► │   Log Event  │
│   (3 events) │          │  (1,778 unique IDs)  │          │  (2 events)  │
└──────┬───────┘          └──────────┬───────────┘          └──────┬───────┘
       │ spanId                      │                             │ spanId
       ▼                             ▼                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                                  Spans                                   │
│                           (2,107 unique spans)                           │
│  parentSpanId ──────► spanId (329 nested parent-child connections)       │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ db.system / db.operation
                                     ▼
                  ┌──────────────────────────────────────┐
                  │          Database Operations         │
                  │ (MongoDB: 1,794 | PG: 8 | Prisma: 12)│
                  └──────────────────────────────────────┘
```

- **Request ↔ Trace:** 100% of the 16 requests match their respective root server trace ID and span ID.
- **Trace ↔ Spans:** All 2,107 spans belong to one of the 1,778 trace IDs.
- **Span ↔ Parent Span:** 1,778 spans are root spans (`parentSpanId: null`); 329 spans reference parent span IDs.
- **Error ↔ Trace & Span:** 100% of errors contain `traceId` and `spanId` matching active spans in the trace waterfall.
- **Log ↔ Trace & Span:** 100% of logs contain `traceId` and `spanId`.
- **Database ↔ Span:** Extracted from span attributes (`db.system`, `db.statement`, `db.operation`).

---

## D. Trace Reconstruction Rules & Waterfall Precision

Adhering strictly to **Principle 1.2 (Never invent telemetry)** and **Section 6 (Waterfall Precision)**:

1. **Temporal Boundaries:**
   - `traceStartTime = min(span.startTime)` across all spans in the trace.
   - `traceEndTime = max(span.endTime)` across all spans.
   - `totalDuration = max(traceEndTime - traceStartTime, trace.totalDuration)`.
2. **Nesting & Parent-Child Trees:**
   - Spans are sorted chronologically by `startTime`.
   - If `parentSpanId` exists in the trace's span set, it is attached as a child to that parent.
   - **Missing Parent Handling:** If `parentSpanId` is referenced but absent from the raw dataset, the engine creates a virtual container node labeled `Missing parent span: <parentSpanId>` with `status: "missing_parent"`. The orphan spans are grouped beneath it, preserving their exact `offsetMs` and `duration`.
3. **Coordinate Positioning:**
   - `offsetMs = max(0, span.startTime - traceStartTime)`
   - `leftPercent = (offsetMs / totalDuration) * 100`
   - `widthPercent = max(0.4, (span.duration / totalDuration) * 100)`

---

## E. Data Quality Problems & Forensics Discovered

1. **Missing Parent Span `51b55868fbb7c3de`:**
   - In trace `e1150d3ab63d19892bdd2c731a5ef0e9` (`POST /api/auth/signin`), three Prisma spans (`prisma:client:serialize`, `prisma:client:connect`, `prisma:client:compile`) reference `parentSpanId: "51b55868fbb7c3de"`.
   - That span ID does not exist anywhere in `cubicle/spans`, `cubicle/traces`, or `cubicle/raw_batches`.
2. **Telemetry Source Asymmetry (Embedded Root Span):**
   - Trace `67457434c934df0a8f169dba5297cb25` contains `rootSpan: OrganizationInvite.updateMany` (duration: 10,015.76ms, Mongoose buffer timeout error).
   - This span was serialized inside `cubicle/traces/` but was **never written to `cubicle/spans/`**.
3. **Batch Export Redundancy (58 Duplicate Trace Files):**
   - Out of 1,836 files in `cubicle/traces`, there are 1,778 distinct `traceId`s (58 duplicate files).
   - Trace `67457434c934df0a8f169dba5297cb25` was batched and exported 4 distinct times.
4. **Timing Integrity Check:**
   - 0 spans have inverted timestamps (`endTime < startTime`).
   - 0 spans have negative durations.
   - 100% of spans have valid microsecond-resolution durations.

---

## F. Evidence-Backed SDK Bugs vs Application Bugs

| Classification | Location | Evidence / Description |
| :--- | :--- | :--- |
| **SDK Instrumentation Bug** | `@prisma/instrumentation` / `@pulse-apm/node` | **Dropped Prisma Root Span:** The Prisma query root span `51b55868fbb7c3de` was created in context but never closed or exported before transport flush, leaving 3 child spans as orphans. |
| **SDK Exporter Redundancy** | Exporter Queue | **Duplicate Batch Submissions:** 58 trace events were submitted repeatedly across separate HTTP batches during exporter flush cycles. |
| **SDK Telemetry Asymmetry** | Span Exporter vs Trace Exporter | **Omitted Standalone Span:** Mongoose buffering timeout span `c717626018d40059` was exported in the trace summary batch but omitted from the individual spans queue. |
| **Application Bug** | `cubicle-be/src/middleweare/apiActivityTracker.js:24:7` | **Fatal Uncaught TypeError:** Calling `.catch()` on an undefined return value in a `ServerResponse` finish listener triggered a process-level `uncaughtException`, crashing the request. |
| **Driver Warning Interception** | `global-errors.js` & `logging-subsystem.js` | **SSL Deprecation Hooking:** Node.js `pg-connection-string` SSL mode deprecation warnings emitted to `console.error` were intercepted and recorded as handled error events with `statusCode: 200`. |

---

## G. UI Implementation & Page Catalog

| Page | URL | Key Features & Observability Architecture |
| :--- | :--- | :--- |
| **Overview** | `/index.html` | Golden APM signals (16 reqs, 1,778 traces, 2,107 spans, 3 errors, 1,814 DB ops), slowest requests table, slowest traces table, database distribution chart, SDK environment metadata, and diagnostic alert banner. |
| **Requests** | `/requests.html` | Inbound HTTP request explorer with method filtering (GET/POST), status code filtering (200/401), latency bars, collapsible rows revealing headers, client IP, query params, and clickable trace links. |
| **Traces** | `/traces.html` | Trace stream explorer (1,778 traces) with pagination (50/page), duration sorting, error filtering, presets for HTTP requests vs standalone DB commands, and click-through to trace waterfall. |
| **Trace Detail** | `/trace-detail.html?traceId=...` | **Interactive Waterfall:** Sticky timeline ruler, expand/collapse tree, color-coded span bars (server, internal, client, error, missing parent), and **5-tab Span Drawer** (Overview, Attributes, Events/Exceptions, Correlated Telemetry, Raw JSON & Provenance). |
| **Errors** | `/errors.html` | Sentry-style error explorer grouping by fingerprint and type, with interactive stack trace viewer highlighting `inApp` frames, and links to correlated requests and traces. |
| **Logs** | `/logs.html` | Structured log stream viewer with timestamp, level pills, truncated preview, full message inspector, and direct trace navigation. |
| **Databases** | `/databases.html` | Database command explorer with system filtering (MongoDB, Prisma, PostgreSQL), collection/table names, SQL/Mongoose query statements, duration bars, and linked span/trace IDs. |
| **Services** | `/services.html` | Service inventory and performance cards displaying request volume, span count, p50/p95/p99 latency percentiles, and project metadata. |
| **Raw Events** | `/raw-events.html` | Mandatory raw event stream covering all 4,219 files in `cubicle/`, with category filtering, search, pagination, and a live JSON inspector modal. |
| **Diagnostics** | `/diagnostics.html` | Forensic health inspector documenting the missing parent span, duplicate batch submissions, trace asymmetry, and automated integrity validation results. |

---

## H. Validation & Tested Real Traces

The platform was verified through both automated tests and real browser interactions:

1. **Automated Test Suite (`sdk-node/observability-platform/tests/engine.test.js`):**
   - `✔ Phase 1: Ingests all cubicle files without data loss (4,219 files)`
   - `✔ Phase 2 & 3: Correlation and Canonical Data Model (2,107 spans, 1,778 traces)`
   - `✔ Phase 4: Missing Parent Span Detection (trace e1150d3ab63d19892bdd2c731a5ef0e9)`
   - `✔ Phase 5: Multi-Span Trace Waterfall Hierarchy & Timing (44 spans in signin trace)`
   - `✔ Phase 6: Request -> Trace -> Span -> Error -> Log Correlation`
   - `✔ Phase 7: Database Telemetry Extraction (1,814 DB operations)`
   - `✔ Phase 8: Forensic Diagnostics Integrity Checks (0 timing errors, 58 duplicates)`
   - `✔ Phase 9: Edge Cases (Synthetic Unit Checks)`
   - **Result: 9/9 tests passed (0 failures, 100% success rate).**

2. **Browser Subagent Visual Validation:**
   - Navigated to `http://localhost:3300/index.html`. Confirmed all 8 metrics cards rendered with accurate data.
   - Clicked into `trace-detail.html?traceId=e1150d3ab63d19892bdd2c731a5ef0e9`. Verified the 44-span waterfall timeline, horizontal ruler, and prominent missing parent container (`Missing parent span: 51b55868fbb7c3de`).
   - Clicked on span `middleware - urlencodedParser` (`a4a049b032c2d0d5`). Verified the 5-tab span drawer opened with complete metadata, duration (170µs), and provenance.
   - Screenshots and browser recordings captured in artifact directory.

---

## I. Known Limitations

1. **Unclosed Spans Cannot Be Time-Bounded:**
   - The missing parent span `51b55868fbb7c3de` was never exported, so its true start and end timestamps cannot be known. The reconstruction engine bounds its virtual container between the earliest start (14,073ms) and latest end (14,371.91ms) of its known orphan children.
2. **Standalone MongoDB Commands Lack Request Context:**
   - The 1,762 standalone MongoDB `$cmd` traces occurred during Mongoose index initialization outside of incoming HTTP requests. They correctly have `requestId: null`.
3. **Process Warnings Recorded as Handled 200 Errors:**
   - The SSL deprecation warning is an environmental notice rather than an HTTP 500 error. The platform presents it faithfully as a handled warning on `/api/auth/refresh` and `/api/auth/signin`.
