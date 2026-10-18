# Timeouts, Deadlines & Socket Management

## 1. Network Deadlines

Observability dispatches must never hang or block resources waiting on slow network connections. The Pulse transport layer enforces strict deadlines across socket creation, TLS handshakes, and response bodies.

---

## 2. Configured Route Deadlines

Timeout limits are configured per route based on expected payload sizes:

| Telemetry Route | Timeout Deadline | Rationale |
|---|---|---|
| **`errors`** | 3,000 ms (3 sec) | Critical errors must deliver rapidly or fail fast. |
| **`requests`** | 3,000 ms (3 sec) | Request logs prioritize low latency. |
| **`traces`** | 5,000 ms (5 sec) | Accommodates multi-span compressed batches. |
| **`spans`** | 5,000 ms (5 sec) | Standard batch timeout. |
| **`metrics`** | 5,000 ms (5 sec) | High-volume metric batches. |
| **`logs`** | 5,000 ms (5 sec) | Standard log buffer timeout. |
| **`crons`** | 5,000 ms (5 sec) | Heartbeat check-in deadline. |
| **`profiles`** | 15,000 ms (15 sec) | Multi-megabyte V8 CPU profile trees. |

---

## 3. Socket Pooling & Lifecycle

Connection pooling is handled by `ConnectionManager` in [`src/transport/connection-manager.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/transport/connection-manager.ts):

- **`connectTimeout`:** 2,000 ms connection deadline. If a TCP handshake does not complete within 2 seconds, the socket is destroyed and the attempt is classified as a retryable network timeout.
- **`keepAlive`:** Enabled with `keepAliveMsecs: 10,000`.
- **Idle Socket Cleanup:** Idle sockets are culled after 15 seconds of inactivity to avoid holding open unused file descriptors.
- **Socket Destruction on Shutdown:** When `shutdown()` is called, all open sockets in the pool are forcefully closed (`socket.destroy()`).
