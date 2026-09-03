# Remote Telemetry Budget Audit

## 1. Executive Summary

This checkout is the Node SDK repository only. I found SDK remote-config client, validation, runtime refresh, event pipeline, persistence governor, cost governor, batching, and transport code. I did not find backend controllers, database schema, migrations, serializers, or persistence for remote configuration in this repository.

Final verdict:

| Area | Verdict |
| --- | --- |
| Remote Configuration Status | PARTIALLY IMPLEMENTED |
| SDK Enforcement Status | PARTIALLY CORRECT |
| Runtime Update Status | LIVE for supported fields; NOT SUPPORTED for persistence event budget and telemetry byte budget |
| Current 5000 events/min source | HARDCODED_CONSTANT in SDK `PersistenceGovernor` |
| Current 10 MB/min source | SDK_DEFAULT / HARDCODED_CONSTANT in SDK `CostGovernor` |
| Biggest problem | Budget-looking knobs for persistence events and telemetry bytes are not part of the remote config schema and are not updated at runtime; the byte budget only logs after successful sends and does not enforce reduction/drop behavior. |

The current SDK does not have end-to-end remote configuration support for telemetry persistence event budgets or telemetry byte budgets. It has a hardcoded persistence budget of 5000 persisted events per minute and a hardcoded/default byte budget of 10 MB per minute. The SDK enforces the persistence budget only on failed-send durable persistence, not on normal event capture or batch sending. The SDK records byte budget usage only after successful batch sends and logs when over budget; it does not abort, drop, delay, sample, or reconfigure transport behavior based on that byte budget.

## 2. Current Remote Config Architecture

File: `src/types/config.ts`
Function/Type: `NormalizedRemoteConfig`
Line: 18-44

Observed behavior: the SDK's remote snapshot contains `sdk`, `features`, `sampling`, `instrumentation`, `privacy`, `limits`, `killswitches`, `transport`, `meta`, `entitlements`, and optional subsystem sections. There is no `maxEventsPerMinute`, `maxBytesPerMinute`, `persistenceEventBudget`, `telemetryBytesPerMinute`, or tier policy section.

Conclusion: remote config supports many operational controls, but not the audited persistence event/byte budget fields.
Confidence: HIGH

File: `src/core/remote-config-client.ts`
Function: `RemoteConfigClient.initialize()`, `fetchLatest()`, `post()`
Line: 51-83, 85-145

Call path:
`init()` -> `new RemoteConfigClient()` -> `initialize()` -> `POST /api/v1/init`

Observed behavior: startup calls `/api/v1/init`; refresh calls `/api/v1/sdk-config`; both are POSTs with API key header and `{}` body. The client has no local project/org/environment config merge.

Conclusion: the SDK receives complete backend-owned config snapshots, but backend implementation and DB persistence are not in this repo.
Confidence: HIGH

## 3. Current SDK Configuration Architecture

File: `src/core/init.ts`
Function: `initialize()`
Line: 89-116, 131-135, 278-327

Observed behavior: init validates and installs one remote snapshot, initializes engines from it, builds `TransportRouter` from `config.transport` and `config.limits`, configures tenant governance, and updates `costGovernor` only with `maxSpansPerTrace` and a trace duration default.

Conclusion: supported remote fields are applied at SDK startup. Persistence event budget and byte budget are not wired from config at startup.
Confidence: HIGH

## 4. Configuration Data Flow

Actual flow:

```text
POST /api/v1/init
  -> InitResponse.config
  -> ConfigManager.initialize()
  -> assertRemoteConfig()
  -> immutable active snapshot
  -> engines/router/subsystems initialized
  -> event pipeline reads active snapshot
  -> TransportRouter/BatchManager send telemetry
  -> successful telemetry ACK may signal refresh
  -> POST /api/v1/sdk-config
  -> complete snapshot replacement
  -> ConfigApplier updates changed subsystems
```

File: `src/core/config-manager.ts`
Function: `handleTelemetryResponse()`, `refreshOnce()`
Line: 88-105, 128-173

Observed behavior: runtime refresh is triggered only by a successful telemetry response with `change === true` and HTTP/status 202. Refresh validates a full replacement, ignores older snapshots, compares a hash, atomically swaps `currentConfig`, and retains the previous snapshot on refresh failure.

Conclusion: runtime refresh exists, but there is no polling interval and unsupported budget fields cannot become live because the schema and appliers do not include them.
Confidence: HIGH

## 5. Event Budget Audit

File: `src/storage/persistence-governor.ts`
Function: module constant, constructor, `shouldPersist()`
Line: 40-45, 59-83, 95-122, 231-249

Resolved behavior: `DEFAULT_MAX_PERSIST_PER_MINUTE = 20000`; `limits.persistenceGovernance.maxPersistPerMinute` is now validated from remote config and applied to the exported singleton during init and full-snapshot refresh. `shouldPersist()` exempts `critical` tier from budget rejection, checks `getCurrentPersistRate() >= maxPersistPerMinute`, logs aggregated `Persistence governor: persist budget exceeded` warnings, and returns false for non-critical events over budget.

Conclusion: the SDK has a backend-owned event persistence budget. It affects only failed-send persistence to disk, not normal transport admission.
Confidence: HIGH

Classification:

| Question | Answer |
| --- | --- |
| Defined? | Yes, `PersistenceGovernorOptions.maxPersistPerMinute` |
| Default | 20000 |
| Maximum allowed | 1000000 by SDK config validation |
| Persisted in DB | `remote_config.persistence_max_per_minute` in the documented database schema |
| Exposed through API | Not found in this repo |
| Returned to SDK | `limits.persistenceGovernance.maxPersistPerMinute` |
| Validated | `ConfigValidator` validates `limits.persistenceGovernance.*` |
| Cached | Runtime singleton state only |
| Changeable remotely | Yes |
| SDK receives change | No |
| Applied without redeploy | No |
| Enforced | Yes, only in failed-batch persistence path |
| Affected classes | Non-critical persistence tiers: `important` and `transient`; `critical` bypasses budget |

## 6. Byte Budget Audit

File: `src/utils/cost-governor.ts`
Function: constructor, `recordBytesSent()`, `shouldReduceTelemetry()`
Line: 19-30, 49-78, 156-171, 195-200

Observed behavior: `bytesBudgetPerMinute` is a readonly constructor option defaulting to `10 * 1024 * 1024`. The exported singleton is created as `new CostGovernor()` at line 284. `updateFromConfig()` accepts only `maxSpansPerTrace` and `maxTraceDurationMs` at line 88. `recordBytesSent()` logs `Telemetry bytes budget exceeded` when current successful-send bytes exceed the budget.

File: `src/transport/batch-manager.ts`
Function: `sendBatch()`
Line: 371-382

Call path:
`BatchManager.sendBatch()` -> successful `fetch()` response -> `costGovernor.recordBytesSent(Buffer.byteLength(body))`

Observed behavior: byte accounting happens only after `response.ok`. The logged `budget = 10.00MB/min` originates from `CostGovernor` constructor default, not remote config. No caller uses `shouldReduceTelemetry()` except stats/utilization inside the same class.

Conclusion: the byte budget is not remote configurable and is not an enforcement mechanism. It is post-success accounting plus warning logs.
Confidence: HIGH

## 7. Tier/Priority Policy Audit

There are two separate priority/tier concepts.

File: `src/storage/persistence-governor.ts`
Function: `classifyDurability()`, `evaluatePressureMatrix()`
Line: 138-157, 184-211

Observed behavior: persistence durability tiers are hardcoded: `error` -> `critical`; `request` and `span` -> `important`; everything else -> `transient`. Under elevated/high/critical adaptive pressure, non-critical tiers are preserved/sampled/dropped according to a hardcoded matrix.

Conclusion: persistence tier policy exists, but it is SDK hardcoded and not remote-configurable.
Confidence: HIGH

File: `src/types/config.ts`
Type: `TransportRouteConfig.priority`
Line: 401-409

File: `src/transport/transport-router.ts`
Function: `toQueuePriority()`, `buildRuntime()`
Line: 28-34, 342-383

Observed behavior: remote config controls route priority values `critical | high | normal | low`, which map into queue priorities `high | normal | low`. `critical` and `high` both become queue `high`. This controls queue reserve/drop behavior, not persistence governor durability classification.

Conclusion: route priority is remote-configurable; persistence durability policy is not.
Confidence: HIGH

## 8. Persistence Governor Audit

File: `src/storage/persistence-governor.ts`
Function: `shouldPersist()`, `getCurrentPersistRate()`, `recordPersist()`
Line: 95-134, 235-249

Observed behavior: event rate is a process-local sliding 60-second window of persisted event timestamps. Expired entries are removed by repeated `shift()`. Counters live in a singleton. Critical events always call `recordPersist()`, so they increase current rate even though they bypass the budget check. Non-critical events are rejected when the window length is at or above 5000.

Scope: process / SDK singleton instance. It is not per project, org, environment, API key, host cluster, or backend tenant. Tenant-level rate limiting is separate.

Concurrency: JavaScript event-loop single-threaded mutation of arrays/maps; no locking or worker-shared state.

Memory: one timestamp object per persisted event in the last 60 seconds, plus stats counters.

Behavior when exceeded: return false to caller; caller filters the event out of durable persistence.

## 9. Batch Interaction

File: `src/transport/batch-manager.ts`
Function: `nextSerializableBatch()`, `sendBatch()`, `persistOnFailure()`
Line: 186-241, 243-457, 520-531

Observed behavior: batches are formed by draining route queues, scrubbing/sanitizing, JSON serializing, and comparing serialized byte size to `limits.maxPayloadSize`. Persistence governor is not checked before batch creation or HTTP transmission. It is checked per event only in `persistOnFailure()` after connection failure, retryable HTTP failure, or network error.

For a 250-event batch: if the serialized payload is within `maxPayloadBytes`, the batch sends. If sending succeeds, `recordBytesSent()` records serialized bytes once. If sending fails, `persistOnFailure()` filters the 250 events through `persistenceGovernor.shouldPersist()` one by one before durable storage.

Conclusion: budgets do not prevent expensive serialization or HTTP send. Persistence budget can reject durable storage after a failed send.
Confidence: HIGH

## 10. Transport Interaction

File: `src/transport/transport-router.ts`
Function: `send()`, `buildRuntime()`
Line: 118-149, 334-389

Observed behavior: events route by event type into per-route `BatchManager`s. Remote transport config controls route URL, batch size, flush interval, timeout, compression field, keep-alive, retry, connections, queue max size, and critical reserve.

File: `src/transport/transport-event-queue.ts`
Function: `enqueue()`, `requeueFront()`, `isCritical()`
Line: 62-95, 114-141, 217-220

Observed behavior: queue criticality is event-content based: fatal errors, fatal logs, and error cron check-ins. It is not the same as route priority.

Conclusion: transport has remote-controlled batching/queue knobs, but not telemetry event/min or bytes/min budgets.
Confidence: HIGH

## 11. Retry/Abort Interaction

File: `src/transport/batch-manager.ts`
Function: `shutdown()`, `sendBatch()`, `retryOrRetain()`
Line: 120-138, 273-276, 339-349, 431-448, 459-497

Observed behavior: HTTP aborts originate from `AbortController`: active requests are aborted on manager shutdown; each request also has a timeout based on `socketTimeoutMs`. The `catch` block logs `[TransportRouter] Batch send failed` with the thrown error message and then persists/retries the failed batch.

Answer: exceeding the persistence/telemetry budget does not cause the SDK HTTP batch request to be aborted in the code inspected. Persistence budget is checked only after send failure. Byte budget is recorded only after successful sends. The abort mechanism is request timeout or `BatchManager.shutdown()`/transport reconfiguration shutdown.

Confidence: HIGH

## 12. Runtime Refresh Audit

File: `src/core/config-applier.ts`
Function: `apply()`
Line: 48-78

File: `src/core/init.ts`
Function: `manager.setApplier(...)`
Line: 278-327

Observed behavior: runtime refresh can apply identity, killswitches, sampling, features, limits, privacy, transport, instrumentation, and entitlements. Limits changes update `LimitsEngine`, tenant governance, adaptive memory pressure, pre-init queue size, and cost governor span count. Transport changes rebuild router runtime.

Resolved for persistence: runtime config refresh now updates `PersistenceGovernor.maxPersistPerMinute` through `limits.persistenceGovernance`. Still missing: no runtime path updates `CostGovernor.bytesBudgetPerMinute`; it is readonly and absent from `updateFromConfig()`.

## 13. Configuration Precedence

Actual precedence:

| Source | Priority | Fallback |
| --- | --- | --- |
| `/api/v1/init` complete config | Startup authority | If missing/invalid/unavailable, init fails open and telemetry remains uninitialized |
| `/api/v1/sdk-config` complete config | Runtime replacement authority after ACK signal | If invalid/unavailable/older/unchanged, retain last valid snapshot |
| SDK default remote config constants | Used by helper normalization APIs/tests; not used by `ConfigManager.prepareConfig()` as merge fallback | Safe defaults exist but startup path does not merge them |
| Environment | Only `SDK_BASE_URL` selects control-plane origin | Not runtime telemetry policy |
| User init options | API key/base URL/debug/log-level/plugins/hooks/source maps | Not remote telemetry policy |
| Hardcoded governor defaults | Always active for persistence event budget and byte budget | No remote override |

## 14. Configuration Scope

| Capability | Scope Proven From Code |
| --- | --- |
| Persistence event budget | Process-local singleton `persistenceGovernor` |
| Byte budget | Process-local singleton `costGovernor` |
| Transport queue limits | Per route in this SDK process, built from active remote config |
| Tenant governance | Per SDK process, keyed by event tenant id |
| Remote identity | Active SDK process snapshot from backend config |

## 15. Hardcoded Value Inventory

| Value | File | Line | Classification | Notes |
| --- | --- | ---: | --- | --- |
| `5000` persisted events/min | `src/storage/persistence-governor.ts` | 59 | HARDCODED_CONSTANT | Source of observed `budget=5000` log |
| `10 * 1024 * 1024` bytes/min | `src/utils/cost-governor.ts` | 76 | SDK_DEFAULT / HARDCODED_CONSTANT | Source of observed `budget=10.00MB/min` log |
| `60_000` persistence window | `src/storage/persistence-governor.ts` | 67 | HARDCODED_CONSTANT | Sliding window duration |
| `60_000` byte window | `src/utils/cost-governor.ts` | 63 | HARDCODED_CONSTANT | Sliding window duration |
| `10_000` max pending pipelines | `src/core/event-pipeline.ts` | 84 | HARDCODED_CONSTANT | Capture pipeline overload cap |
| Transport route batch sizes/timeouts | `src/constants/defaults.ts` | 72-83 | SDK defaults | Remote config can override only when delivered and accepted |
| Offline queue `10 * 1024 * 1024` file size | `src/constants/defaults.ts` | 108-115 | SDK default remote config field | Separate from telemetry byte budget |

## 16. End-to-End Evidence

Event call path:

```text
capture helper
  -> processEvent()/enqueueEvent()
  -> processEventAsync()
  -> feature/killswitch/sampling/tenant/limits gates
  -> normalize/sanitize/enrich/hooks
  -> TransportRouter.send()
  -> BatchManager.enqueue()
  -> nextSerializableBatch()
  -> fetch()
  -> on success: costGovernor.recordBytesSent()
  -> on failure: persistenceGovernor.shouldPersist() -> persistentStorage.persistBatch()
```

Key evidence:

File: `src/core/event-pipeline.ts`
Function: `processEventAsync()`
Line: 327-361, 521-545

Observed behavior: active config gates features, sampling, tenant governance, and limits. Persistence is explicitly not on the success path.

Conclusion: governor persistence is not part of capture admission or normal routing.
Confidence: HIGH

## 17. Gap Analysis

Implemented:

- Complete SDK-side remote config snapshot validation and atomic replacement.
- Runtime refresh on telemetry ACK `202` + `change: true`.
- Remote transport route config, queue capacity, route priority, retries, timeouts, and payload caps.
- Hardcoded persistence durability classification and pressure matrix.
- Process-local tenant governance from remote `limits.tenantGovernance`.

Partially implemented:

- Byte budget exists as a `CostGovernor` constructor option and warning logger, but is not remote-wired and does not enforce.
- Event persistence budget exists as a `PersistenceGovernor` constructor option and enforcement, but the singleton is not remote-wired.

Dead configuration:

- No remote budget fields were found for the audited event/byte budgets.
- `CostGovernor.shouldReduceTelemetry()` currently has no external consumer in `src` or `tests`.

Hardcoded configuration:

- `5000` persisted events/min.
- `10 MB/min` telemetry byte warning threshold.
- Persistence durability tiers and sampling/drop matrix.

SDK missing:

- Config schema for persistence/byte budgets.
- Validation bounds for those budgets.
- Runtime applier support for governor budget updates.
- Enforcement path for byte budget.

Backend missing:

- Backend source is not present in this repo, so backend support for database/API persistence cannot be proven.

Runtime missing:

- Live updates for persistence event budget and byte budget.

Dangerous behavior:

- Byte budget exceedance can create alert noise because it logs but does not reduce traffic.
- Persistence budget can starve non-critical durable replay during transport failure while normal in-memory retry continues.
- Abort logs can be misattributed to budgets; actual aborts are timeout/shutdown/reconfiguration.

## 18. Security/Safety Risks

- Remote config cannot directly set the audited budgets to dangerous values because those fields do not exist.
- Existing remote-controlled fields have SDK safety ceilings in `src/core/config-validator.ts` and `src/constants/limits.ts`, including queues, payload size, retries, route timeouts, and tenant governance.
- Because budget fields are hardcoded, operators cannot remotely lower traffic/byte budgets during an incident except through sampling, killswitches, queue/transport controls, or feature disabling.

## 19. Performance Risks

- `PersistenceGovernor.getCurrentPersistRate()` and `CostGovernor.getCurrentBytesPerMinute()` prune arrays with `shift()`, which is O(n) per expired item.
- Byte accounting happens after serialization/compression and successful HTTP response, so it does not prevent CPU/network cost.
- Failed batches are persisted and scheduled for retry; repeated failures can count persistence attempts per failure attempt until retry limits are exhausted.

## 20. Recommended Changes

Target architecture:

```text
Remote Config
  -> Validated Config
  -> SDK Runtime Config
  -> Persistence Governor
  -> Priority-aware degradation
  -> Batching
  -> Transport
```

Recommended changes, based on current gaps:

- Add explicit remote schema fields for persistence event budget and telemetry byte budget with SDK safety ceilings.
- Make `PersistenceGovernor` and `CostGovernor` budget values mutable through validated runtime config updates.
- Decide whether byte budget should enforce admission, sampling, delayed flush, or transport shedding; current code only logs.
- Keep abort/timeout control separate from budget enforcement so budget pressure does not masquerade as network failure.
- Add tests proving live refresh changes governor behavior without redeploy.

## 21. Validation/Test Plan

- Unit test: config validator accepts valid budget fields and rejects 0/negative/NaN/Infinity/extreme values once fields exist.
- Unit test: `PersistenceGovernor` budget update changes `shouldPersist()` decisions at runtime.
- Unit test: `CostGovernor` byte-budget update changes utilization/enforcement behavior at runtime.
- Integration test: `/v1/init` supplies budgets and SDK uses them.
- Integration test: telemetry ACK triggers `/v1/sdk-config`, budgets change, and governor state changes without reinit.
- Transport test: budget exceeded does not call `AbortController.abort()` unless explicitly designed and documented.
- Retry test: failed batch retry counts persistence attempts intentionally and does not cause unbounded queue growth.

## 22. Final Verdict

Remote configuration does not currently support the audited telemetry persistence/event/byte budgets end to end in this SDK repository.

| Setting | Actual Value | Source | Remote Config? | SDK Receives? | SDK Enforces? |
| --- | ---: | --- | --- | --- | --- |
| Event budget | 5000/min | HARDCODED_CONSTANT, `PersistenceGovernor` | NO | NO | YES, failed-send persistence only |
| Byte budget | 10 MB/min | SDK_DEFAULT / HARDCODED_CONSTANT, `CostGovernor` | NO | NO | NO, logs only |
| Important policy | request/span preserve/sample/drop matrix | HARDCODED_CONSTANT | NO | N/A | YES, failed-send persistence only |
| Transient policy | fallback tier preserve/sample/drop matrix | HARDCODED_CONSTANT | NO | N/A | YES, failed-send persistence only |

Capability table:

| Capability | Backend | Remote API | SDK Fetch | Runtime Refresh | Governor Uses It | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Event/min budget | Not found | Not found | No | No | Hardcoded only | NOT IMPLEMENTED as remote config |
| Bytes/min budget | Not found | Not found | No | No | Hardcoded logger only | NOT IMPLEMENTED as remote config |
| Tier policy | Not found | Route priority only | Route priority only | Transport priority live | Persistence policy hardcoded | PARTIAL |
| Sampling | Not found server-side | Present in SDK schema | Yes | Yes | SamplingEngine uses it | SDK IMPLEMENTED |
| Pressure levels | Not found server-side | Feature/memory limits only | Yes | Partially | Persistence governor reads adaptive pressure | PARTIAL |
| Runtime update | Not found server-side | `/v1/sdk-config` client | Yes after ACK | Yes for supported fields | No for audited budgets | PARTIAL |
