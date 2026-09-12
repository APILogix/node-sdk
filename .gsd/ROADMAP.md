# ROADMAP.md

> **Current Phase**: Not started
> **Milestone**: v2.0 — Universal Database & Framework Autoinstrumentation Hardening

## Must-Haves (from SPEC)
- [ ] MySQL2 queries emit canonical `db.system: mysql` spans with sanitized statements.
- [ ] GraphQL queries generate resolver child spans linked to the root GraphQL operation.
- [ ] BullMQ job lifecycles maintain trace context from enqueue to worker completion.
- [ ] Hot-path micro-benchmarks demonstrate < 1ms interception overhead.
- [ ] 100% test pass rate across existing 429+ unit, integration, and e2e test suites.

---

## Phases

### Phase 1: MySQL2 & Relational Database Hardening
**Status**: ⬜ Not Started  
**Objective**: Harden MySQL2 instrumentation across connection pools, direct connections, and prepared statements with automatic SQL statement sanitization and context propagation.  
**Requirements**: REQ-01, REQ-02, REQ-07  

### Phase 2: GraphQL & BullMQ Background Job Tracing Parity
**Status**: ⬜ Not Started  
**Objective**: Implement resolver-level GraphQL tracing and BullMQ queue/worker lifecycle context propagation, ensuring asynchronous jobs inherit initiating request traces.  
**Requirements**: REQ-03, REQ-04, REQ-07  

### Phase 3: Hot-Path Performance & Zero-Allocation Optimization
**Status**: ⬜ Not Started  
**Objective**: Streamline hot-path context lookups, optimize span generation for high-throughput query loops, and ensure zero-allocation suppression when tracing is disabled or unsampled.  
**Requirements**: REQ-05, REQ-06  

### Phase 4: Integration Benchmarking, Regression & Verification
**Status**: ⬜ Not Started  
**Objective**: Validate end-to-end trace assembly across all database and framework integrations under concurrent load, verifying sub-millisecond overhead and zero test regressions.  
**Requirements**: REQ-08  
