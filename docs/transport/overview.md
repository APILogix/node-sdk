# Transport Layer Overview

## 1. Multi-Route Multiplexed Transport

The transport layer in [`src/transport/transport-router.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/transport-router.ts) provides a dedicated, multiplexed delivery architecture for the 10 distinct telemetry streams supported by Pulse.

Instead of funneling all telemetry into a single monolithic queue, Pulse partitions events into 10 independent routes:

```
                                  +-------------------+
                                  |    EventQueue     |
                                  +-------------------+
                                            |
                                            v
                                  +-------------------+
                                  |  TransportRouter  |
                                  +-------------------+
                                            |
     +-----------+-----------+--------------+--------------+-----------+
     |           |           |              |              |           |
     v           v           v              v              v           v
  /errors     /traces     /spans        /metrics         /logs      /requests
  (1s flush)  (5s flush)  (5s flush)    (10s flush)   (10s flush)   (5s flush)
  (100 batch) (500 batch) (500 batch)  (1000 batch)   (200 batch)   (500 batch)
     |           |           |              |              |           |
     +-----------+-----------+--------------+--------------+-----------+
                                            |
                                            v
                               +-------------------------+
                               |    ConnectionManager    |
                               |  (Keep-Alive HTTP Pool) |
                               +-------------------------+
                                            |
                                            v
                               +-------------------------+
                               | Pulse Ingestion Backend |
                               +-------------------------+
```

---

## 2. Supported Telemetry Routes

| Route Identifier | Target Endpoint | Default Batch Size | Default Interval | Compression |
|---|---|---|---|---|
| **`errors`** | `/v1/errors` | 100 | 1,000 ms | Gzip |
| **`traces`** | `/v1/traces` | 500 | 5,000 ms | Gzip |
| **`spans`** | `/v1/spans` | 500 | 5,000 ms | Gzip |
| **`requests`** | `/v1/requests` | 500 | 5,000 ms | Gzip |
| **`metrics`** | `/v1/metrics` | 1,000 | 10,000 ms | Gzip |
| **`logs`** | `/v1/logs` | 200 | 10,000 ms | Gzip |
| **`crons`** | `/v1/crons` | 1 | 0 ms (immediate) | None / Gzip |
| **`profiles`** | `/v1/profiles` | 5 | 30,000 ms | Gzip |
| **`events`** | `/v1/events` | 50 | 5,000 ms | Gzip |

---

## 3. Connection Management & Keep-Alive Pooling

The `ConnectionManager` ([`src/transport/connection-manager.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/connection-manager.ts)) maintains persistent HTTP/HTTPS connections:
- **Keep-Alive Enabled:** Sockets remain open across telemetry dispatches (`keepAlive: true`, `keepAliveMsecs: 10,000`).
- **Socket Limits:** Maximum 20 simultaneous sockets per host.
- **DNS Caching:** Resolved IP addresses are cached with TTL to avoid redundant DNS lookups on every batch flush.
- **Timeout Cleanup:** Inactive sockets are recycled automatically to prevent resource leaks.
