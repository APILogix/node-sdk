# SPEC.md — Project Specification

> **Status**: `FINALIZED`
> **Project**: `@pulse-apm/node` — Milestone 2: Universal Database & Framework Autoinstrumentation Hardening

---

## Vision

Deliver enterprise-grade, zero-configuration autoinstrumentation across all major Node.js databases, query layers, and background job runners. Ensure that every database operation (MongoDB, Mongoose, Prisma, PostgreSQL, MySQL2), GraphQL resolver, and BullMQ job is intercepted with sub-millisecond hot-path overhead, leak-proof context propagation, sanitized statements, and empirical test coverage.

---

## Goals

1. **MySQL2 Parity**: Provide comprehensive autoinstrumentation for MySQL2 connection pools, direct connections, and prepared statements with statement sanitization.
2. **GraphQL Resolver Tracing**: Intercept GraphQL execution and resolver functions, extracting operation names and syntax while linking resolvers directly to the parent HTTP trace.
3. **BullMQ Job Tracing**: Propagate distributed trace context across job queues (`queue.add`) and worker job handlers (`Worker.process`), maintaining parent-child span relationships.
4. **Hot-Path Overhead Reduction & Zero Allocation**: Minimize CPU and memory allocations in high-throughput query loops, optimizing context lookups and suppressing un-sampled spans with minimal latency overhead (< 1ms per query).
5. **Universal Autoinstrumentation Robustness**: Maintain defensive fail-open guarantees across all modules, ensuring no APM failure can crash or alter host application behavior.

---

## Non-Goals (Out of Scope)

- Modifying the Pulse backend ingestion server protocol or altering wire compression standards.
- Introducing breaking changes to existing `Pulse.init()` options or public TypeScript types.
- Supporting legacy Node.js runtimes prior to Node 18.

---

## Users

- **Backend Engineers & SREs**: Developing and maintaining mission-critical Node.js services across microservices, monolithic APIs, and asynchronous background worker clusters.
- **Enterprise Platforms**: Requiring continuous observability, automated database transaction tracing, and compliance-grade data sanitization with zero manual instrumentation code.

---

## Constraints

- **Compatibility**: Dual support for CommonJS (`require`) and Node.js native ESM (`--import`).
- **Telemetry Standard**: OpenTelemetry API 1.9.1 / Core 2.11.0 compliant span and resource models.
- **Performance Budget**: Hot-path query interception must incur less than 1.0 ms median overhead.
- **Zero-Code Instrumentation**: All tracing must install automatically via module hooking and prototype patching.

---

## Success Criteria

- [ ] MySQL2 queries emit canonical `db.system: mysql` spans under active request handlers.
- [ ] GraphQL queries generate resolver child spans linked to the root GraphQL operation.
- [ ] BullMQ job lifecycles maintain trace context from enqueue to worker completion.
- [ ] Hot-path micro-benchmarks demonstrate < 1ms interception overhead.
- [ ] 100% test pass rate across existing 429+ unit, integration, and e2e test suites.
