# Integration Testing

## 1. Overview

Integration tests verify that `@pulse-apm/node` correctly intercepts and traces real Node.js network frameworks and database drivers without introducing timing errors, connection leaks, or unhandled exceptions.

---

## 2. Tested Framework & Driver Integrations

### 2.1 Express.js
- Verifies that `monitorMiddleware()` correctly extracts route patterns (`/users/:id`), records response status codes, and binds `AsyncLocalStorage`.
- Verifies that `expressErrorHandler()` intercepts uncaught controller exceptions and emits `ErrorEvent` records before passing the error to default handlers.

### 2.2 PostgreSQL (`pg`)
- Verifies that `pg.Pool.prototype.connect` and `pg.Client.prototype.query` produce database child spans.
- Verifies SQL statement parameter sanitization (e.g., parameter values replaced with `$1`, `$2`).

### 2.3 Redis (`ioredis` & `redis`)
- Verifies that Redis command dispatches (`GET`, `SET`, `HGETALL`) produce spans with truthful execution latency.
- Verifies that connection timeouts or command errors attach error tags to spans without crashing client connections.

### 2.4 OpenTelemetry Context Bridge
- Verifies end-to-end distributed context flow: an incoming HTTP request containing W3C `traceparent` headers extracts the trace ID, passes it to database queries, and propagates it to outbound `fetch()` requests.
