# Testing Strategy & Test Suites

## 1. Testing Philosophy

The Pulse Node.js SDK operates inside customer production processes. A defect in the SDK can directly impact customer application reliability. Consequently, the SDK undergoes rigorous multi-layer testing:

```
+---------------------------------------------------------------+
|                    Adversarial Red-Team Tests                 |
|       (Chaos injection, memory soak, event-loop starvation)   |
+---------------------------------------------------------------+
                                |
+---------------------------------------------------------------+
|                    Integration Test Suites                    |
|    (Express, Fastify, PostgreSQL, Redis, MongoDB, OTel)       |
+---------------------------------------------------------------+
                                |
+---------------------------------------------------------------+
|                      Unit Test Suites                         |
|   (State machine, Queue capacity, Scrubbers, Backoff formula) |
+---------------------------------------------------------------+
```

---

## 2. Test Suite Structure

Test suites reside under `tests/`:

- **`tests/unit/`:**
  - `final-init-recovery.test.ts` — Cold-start initialization, recovery worker backoff, single-flight locking, OTel preservation.
  - `event-loop-safety.test.ts` — Event-loop lag monitoring, HTTP endpoint unblocking, recovery delay production hardening.
  - `trace-span.test.ts` — Span creation, timing attribution, monotonic exclusive duration calculations.
  - `error-capture.test.ts` — Normalization, stack parsing, circular references.
  - `queue.test.ts` — Priority tiering, capacity ceiling, eviction logic.
- **`tests/integration/`:**
  - `final-adversarial-audit.test.ts` — Complete 10-vector red-team adversarial audit suite.
  - `express-integration.test.ts` — Real Express HTTP server with middleware.
  - `pg-integration.test.ts` — Live PostgreSQL client queries and pool interception.
  - `redis-integration.test.ts` — Live Redis command tracing.
- **`tests/fixtures/`:**
  - `remote-config.ts` — Valid and invalid mock control-plane JSON responses.

---

## 3. Test Runners & Commands

The project uses the Node.js native test runner (`node --test`) with TypeScript precompilation:

```bash
# Run all unit tests
npm run test:unit

# Run all integration tests
npm run test:integration

# Run entire test suite
npm test
```
