# Event Metadata Coverage Analysis

**Question:** Does every event sent to the backend contain metadata?

**Answer:** Yes. Every event that reaches the backend carries a complete,
authoritative `EventMetadata` object. This is guaranteed structurally by a
single mandatory pipeline stage, verified below by direct source citations.

> Method note: findings are from static code tracing and reading the existing
> integration test's assertions. This environment has no terminal, so the test
> was not executed here. To get a live pass/fail, run `npm run test:integration`.

---

## 1. Single mandatory attachment point

`src/core/event-pipeline.ts` — `processEventAsync()`, immediately before transport:

```ts
// SDK-owned package identity is reattached after all user/plugin hooks.
event = { ...event, metadata: client.metadata } as SDKEvent
...
const transportRouter = TransportRouter.getInstance()
if (!transportRouter || !transportRouter.send(event)) { ... }
```

Metadata is also set earlier by `normalizeEvent(event, client.metadata)`
(`src/processors/normalizer.ts`), then re-asserted here **after** all user and
plugin hooks, so `beforeSend`/processors cannot strip or forge it.

## 2. The backend is only reachable through that point

`TransportRouter.send()` (`src/transport/transport-router.ts`) is the sole path
to the network (`BatchManager` → `fetch` in `src/transport/batch-manager.ts`).
It is called only from `processEventAsync`, plus `sendBatch()` for
residual/reinit migration — and those residual events were already processed
through the pipeline, so they already carry metadata.

## 3. Every event source funnels through the pipeline

All emission paths call `processEvent`/`enqueueEvent`/`captureEvent` →
`processEventAsync`:

| Source | Evidence |
|---|---|
| Manual capture APIs | `src/capture/*.ts` → `captureEvent` → pipeline |
| Express/Fastify middleware | `src/instrumentation/express.ts`, `fastify.ts` |
| Logging subsystem | `init.ts`: `event => { processEvent(event) }` |
| Profiling subsystem | `init.ts`: `event => { processEvent(event) }` |
| Cron subsystem | `init.ts`: `event => { processEvent(event) }` |
| Trace aggregator (`trace` events) | `trace-aggregator.ts`: `processEvent(traceDocument)` |
| Spans (`span` events) | `tracer.ts` `PipelineSpanExporter.spanToEvent()` sets `metadata` then `processEvent(traceEvent)` |
| Metrics (OTel reader) | `pulse-metric-reader.ts`: `processEvent(event)` per data point |
| Metrics (direct) | `captureMetric.ts` → `captureEvent` → pipeline |
| Pre-init buffered events | `init.ts` `replayBufferedEvents()` → `processEvent` |
| Disk-persisted replays | `init.ts` `replayBufferedEvents()` → `processEvent` |

The pre-init buffer (`enqueueEvent` when `!client.initialized`) uses
`ensureBaseFields`, which does not add metadata — but those events are never
sent while uninitialized, and on init they are re-run through `processEvent`
which attaches metadata.

## 4. `client.metadata` is always complete and authoritative

`src/core/client.ts` — frozen `EventMetadata` with all fields
(`sdkName`, `sdkVersion`, `applicationName`, `applicationVersion`, `projectId`,
`environment`, `release`). `projectId/environment/release` are set from the
validated remote config via `applyRemoteIdentity()` **before** `markInitialized()`,
so no event can transport with the bootstrap placeholder `unknown-project`.

## 5. Scrubbing preserves metadata (last transform before the wire)

`BatchManager.nextSerializableBatch()` scrubs just before `JSON.stringify`:

- `SecurityScrubber.scrub()` (`src/processors/security-scrubber.ts`) shallow-clones
  the event (preserving `metadata`) and explicitly skips it during deep scrub:
  `if (key === 'metadata') continue`.
- The error-path fallback `stripSensitiveSections()` deletes
  `headers/body/context/...` but never `metadata`.
- The alternate `sanitizeEvent()` path (`src/processors/sanitizer.ts`) does not
  classify `metadata` or its keys as sensitive, so it survives.

## 6. Existing test evidence

`tests/integration/public-telemetry-metadata.test.ts` starts a real mock HTTP
backend, captures all 10 event types, decodes the actual gzipped request bodies,
and asserts for **every** routed event:

```ts
assert.ok(event.metadata, `${event.type} on ${path} should have metadata`)
// then checks applicationName, applicationVersion, sdkName, sdkVersion, projectId
```

It also asserts each of the 10 types lands on its expected route.

---

## Per-event-type result

All 10 `SDKEvent` types (`src/types/event.ts`) declare optional
`metadata?: EventMetadata`, and all 10 receive it at the pipeline choke point
regardless of that optionality:

| Event type | Metadata attached | Verified via |
|---|---|---|
| error | Yes | pipeline reattach + integration test |
| message | Yes | pipeline reattach + integration test |
| request | Yes | pipeline reattach + integration test |
| metric | Yes | pipeline reattach + integration test |
| span | Yes | pipeline reattach + integration test |
| trace | Yes | aggregator → processEvent → reattach + test |
| log | Yes | subsystem → processEvent + test |
| profile | Yes | subsystem → processEvent + test |
| replay | Yes | processEvent + test |
| cron_checkin | Yes | subsystem → processEvent + test |

## 7. Export-surface check (no bypass in supported API)

- Public API (`src/index.ts`): exports only capture helpers (`captureError`,
  `captureEvent`, `captureRequest`, `captureMessage`, `captureLog`,
  `captureReplay`, `captureCronCheckIn`, `captureMetric`, ...), lifecycle,
  context, scope, tracing, and instrumentation. `TransportRouter` is
  **deliberately not exported**. Every public capture path routes through
  `enqueueEvent` → `processEventAsync` (metadata attached).
- `captureEvent` (`src/capture/captureEvent.ts`) → `enqueueEvent` is the single
  funnel that all other helpers delegate to.

### Caveat: the internals subpath
`src/internals.ts` exports `TransportRouter` (and `enqueueEvent`). `enqueueEvent`
still routes through the pipeline, so it is safe. `TransportRouter` is the one
**theoretical** bypass — a caller could invoke
`TransportRouter.getInstance()?.send(handBuiltEvent)` with an event lacking
metadata. This is not a supported path:
- The `/internals` subpath is documented as "NO STABILITY GUARANTEES ... only
  for power users and our own integration tests."
- The README states examples intentionally avoid the `internals` subpath.
- The SDK's own code never calls `send()` outside the pipeline (post-metadata)
  or `sendBatch()` for already-processed residuals.

So under all supported usage, no event can reach the backend without metadata.

## Conclusion

Every event reaching the backend contains complete, authoritative metadata.
No supported emission path bypasses `processEventAsync`, `client.metadata` is
always fully populated before init completes, and the pre-transport scrubbers
explicitly preserve the `metadata` field. The only theoretical exception is a
direct call to the unsupported internals `TransportRouter.send()` with a
hand-built event — which the SDK itself never does.
