# Remote Configuration Architecture

This document describes the configuratio/mon system implemented by the Node.js SDK after the single-source-of-truth refactor.

## Summary

The control plane has exactly two operations:

- `POST /v1/init` — the only startup configuration request.
- `POST /v1/sdk-config` — a complete replacement snapshot requested only after a telemetry acknowledgement signals `change: true`.

There is no config polling, TTL refresh, startup prefetch, scheduled retry, stale/default fallback, partial patch, local policy override, or alternate config URL. A failed refresh leaves the last valid snapshot active and another request is attempted only after a later telemetry response signals a change.

## Startup contract

```ts
import { createSDK } from '@vikasbaplawat1/pulse-sdk'

const config = await createSDK({ apiKey: process.env.PULSE_API_KEY! })
```

Startup performs one request:

```http
POST /v1/init
Content-Type: application/json

{"apiKey":"..."}
```

The JSON body has one field: `apiKey`. The SDK does not send local service names, environment overrides, capabilities, package metadata, runtime versions, or configuration defaults.

A successful response contains project information and one complete config document:

```json
{
  "success": true,
  "projectId": "project_123",
  "organizationId": "org_123",
  "environmentId": "env_123",
  "environment": "production",
  "release": "2026.07.30",
  "configRevision": 42,
  "configHash": "backend-hash",
  "config": {
    "schemaVersion": 1,
    "sdk": {
      "projectId": "project_123",
      "service": "payments-api",
      "environment": "production",
      "release": "2026.07.30"
    },
    "features": {},
    "sampling": {},
    "instrumentation": {},
    "privacy": {},
    "limits": {
      "persistenceGovernance": {
        "maxPersistPerMinute": 20000,
        "adaptive": true,
        "budgetExceededLogIntervalMs": 60000
      }
    },
    "killswitches": {},
    "transport": {},
    "meta": {
      "generatedAt": "2026-07-30T07:30:00.000Z",
      "generatedBy": "pulse-control-plane"
    },
    "entitlements": {}
  }
}
```

The abbreviated sections above must contain every field defined by `RemoteConfigResponse`; they cannot be partial objects. See `REMOTE_CONFIG_EXAMPLE.json` for a complete payload.

If `/v1/init` fails or the config is invalid, initialization returns `undefined`. The SDK does not manufacture config, call `/v1/sdk-config`, retry in the background, or start telemetry using baked policy.

## Runtime refresh contract

Every telemetry transport inspects a successful backend response after delivery accounting is complete. A change signal is:

```json
{
  "status": 202,
  "change": true
}
```

The HTTP status may itself be `202`; the SDK also recognizes `status: 202` in the parsed acknowledgement. Processing is:

1. Complete ACK accounting for the current telemetry batch.
2. Start one background `POST /v1/sdk-config` request.
3. Ignore additional `change: true` signals while that request and its apply phase are in flight.
4. Validate the complete response.
5. Compute a canonical SHA-256 hash, independent of a supplied hash.
6. Ignore identical or older snapshots.
7. Atomically replace the immutable active snapshot.
8. Apply only changed sections.

`change: false`, malformed responses, and ordinary success responses produce no configuration request.

The refresh request also contains only the API key:

```http
POST /v1/sdk-config
Content-Type: application/json

{"apiKey":"..."}
```

`/v1/sdk-config` may return the config directly or as `{ "config": { ... } }`. Patch responses are not supported.

## Runtime components

### `RemoteConfigClient`

Owns all control-plane networking. It knows only `/v1/init` and `/v1/sdk-config`, applies a bounded request timeout, suppresses SDK self-instrumentation, disallows redirect credential forwarding, and performs no retries.

### `ConfigValidator`

Validates the entire snapshot before it can become active. It checks the schema version; required project/environment/release identity; all feature and kill-switch booleans; sampling probabilities and route overrides; complete instrumentation shapes (including PostgreSQL, MySQL2, and EventEmitter selection); privacy rules; safety-bounded limits including `limits.persistenceGovernance`; all ten exact transport route URLs; queue capacity/critical reserve and connection policy; metadata; and every entitlement. Unknown fields are tolerated for forward compatibility; missing or malformed required fields reject the whole snapshot. Safety violations reject the snapshot rather than being clamped.

### Persistence Governance

`limits.persistenceGovernance` is mandatory and backend-owned. The SDK does not accept an init option or local override for it.

```json
{
  "limits": {
    "persistenceGovernance": {
      "maxPersistPerMinute": 20000,
      "adaptive": true,
      "budgetExceededLogIntervalMs": 60000
    }
  }
}
```

`maxPersistPerMinute` is a rolling one-minute budget for disk persistence. Critical errors still persist first; once the window is full, non-critical durability tiers are skipped until capacity returns. `adaptive: true` lets the SDK use memory, queue, event-loop, and GC pressure to reduce non-critical disk writes earlier. `budgetExceededLogIntervalMs` controls aggregated SDK warnings when the budget is exhausted.

| Field | Type | Default sent by backend | Safety bounds | Purpose |
|---|---:|---:|---:|---|
| `limits.persistenceGovernance.maxPersistPerMinute` | integer | `20000` | `1..1000000` | Rolling per-minute disk persistence budget before non-critical events are skipped. |
| `limits.persistenceGovernance.adaptive` | boolean | `true` | `true/false` | Enables pressure-aware reduction for important/transient durability tiers. |
| `limits.persistenceGovernance.budgetExceededLogIntervalMs` | integer | `60000` | `1000..600000` | Minimum interval for aggregated budget-exceeded SDK warnings. |

### `ConfigManager`

Owns the only active `RemoteConfigResponse` reference. It deep-clones and recursively freezes accepted documents, computes their canonical hash, atomically swaps a single reference, coordinates one in-flight refresh, and keeps the last valid config on failure. It owns no interval, retry timeout, default merge, local override, or cache layer.

`getConfig()` returns this exact immutable snapshot. The SDK client no longer stores separate remote and resolved config copies.

### `ConfigApplier`

Computes a section-level diff and invokes only affected handlers. Failure in one handler is isolated so independent sections can still converge.

| Changed section | Runtime action |
|---|---|
| `sdk` | Update event identity; restart only OTel tracing/metrics providers because their Resource identity is immutable. |
| `sampling` | Replace deterministic sampling rates; update profiler sampling. |
| `features` | Start or stop only feature subsystems whose flags changed. |
| `killswitches` | Activate/deactivate only mapped capture, OTel, and transport controls. |
| `transport` | Build and atomically swap transport queues/batch managers/routes; migrate queued events. |
| `privacy` | Recompile scrubbing rules and rebuild instrumentation hooks that snapshot capture policy. |
| `limits` | Update limit, tenant, pressure, persistence-governance engines and rebuild transport sizing once. |
| `instrumentation` | Re-register auto-instrumentation only when tracing remained enabled. |
| `entitlements` | Update optional public API gates without restarting in-flight work. |
| `meta`/hash only | Swap the snapshot; do not restart any subsystem. |

## Failure behavior

A `/v1/sdk-config` network, HTTP, JSON, schema, or apply failure:

- never clears the active config;
- never falls back to defaults;
- never disables telemetry by itself;
- never starts a periodic retry;
- becomes eligible for another attempt only after a future `change: true` telemetry acknowledgement.

## Removed behavior

The refactor removed these active paths:

- startup `/v1/sdk-config` fetch;
- `/api/v1/init` configuration endpoint;
- background TTL polling and stale-while-revalidate behavior;
- initial config retry timers and init retry loops;
- baked-config merge and offline policy fallback;
- local feature, sampling, transport, environment, release, privacy, and config URL overrides;
- legacy plan clamping and version-policy configuration;
- client-owned remote/resolved config stores;
- duplicate global batcher implementation;
- derivation of route configuration from a legacy single ingest URL.

Application-local extension hooks, package identity, source-map paths, diagnostics, graceful-shutdown timeout, and breadcrumb capacity remain local concerns; they do not alter backend runtime policy.

## Backend checklist

1. Make `/v1/init` return a complete config in `config`.
2. Include non-empty `sdk.projectId`, `sdk.environment`, and `sdk.release` identity.
3. Ensure all ten routes are present and use their exact final URLs: `traces`, `requests`, `spans`, `errors`, `metrics`, `logs`, `profiles`, `events`, `crons`, and `replays`.
4. Include complete queue (including `criticalReserve`), connection, retry, privacy, limits including `limits.persistenceGovernance`, feature, kill-switch, instrumentation (including `pg`, `mysql2`, and `eventEmitterPatch`), and entitlement sections.
5. Return `202`/`change: true` on telemetry only when a newer snapshot is available.
6. Return a complete config from `/v1/sdk-config`; never return a partial patch.
7. Keep `meta.generatedAt` monotonic. The SDK rejects older snapshots.
8. Expect config requests to be single-flight and event-driven, not periodic.
