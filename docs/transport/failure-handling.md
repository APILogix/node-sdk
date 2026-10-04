# Transport Failure Handling & Isolation

## 1. Core Safety Guarantee

> **Pulse transport failures must never escalate into host application failures.**

If the ingestion endpoint is down, slow, misconfigured, or returning errors:
- Request handlers continue executing normally.
- Database queries proceed unaffected.
- No exceptions are thrown into host application code.
- Node.js heap memory remains bounded by queue and shedding limits.

---

## 2. Failure Handling Matrix

```
Telemetry Dispatch Fails
           |
           +----------------------------------------+
           |                                        |
     Transient Error                         Permanent Error
 (Timeout, 5xx, ECONNRESET)             (401 Unauthorized, 403)
           |                                        |
           v                                        v
   Increment Failure Counter              Disable Route Transport
           |                                        |
   Does Counter >= 5?                     Log Configuration Warning
           |                                        |
     +-----+-----+                                  v
     |           |                         Shed Future Events at Queue
    Yes          No
     |           |
     v           v
Trip Circuit   Retry with Backoff
to OPEN        (Max 3 Attempts)
```

---

## 3. Persistent Disk Fallback (Optional)

When local disk caching is enabled via configuration (`persistence: { enabled: true }`), the SDK initializes `PersistentStorage` ([`src/storage/persistent-storage.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistent-storage.ts)):

- **Disk Spillover:** If the in-memory queue reaches capacity during a prolonged network partition, events are asynchronously written to an encrypted local spool directory (`AppData/Local/pulse-sdk/events` or `/tmp/pulse-sdk/events`).
- **Disk Quota Enforcement:** Managed by `PersistenceGovernor` ([`src/storage/persistence-governor.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/storage/persistence-governor.ts)) with a strict 50MB disk ceiling and 24-hour TTL.
- **Replay upon Reconnection:** Once network health is restored, the SDK replays persisted events in chronological batches without starving live traffic.
