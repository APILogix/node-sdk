# Architectural Decision Records (ADR)

## Format
`[ADR-NNN] Title`
- **Date**: YYYY-MM-DD
- **Status**: Proposed | Accepted | Deprecated | Superseded
- **Context**: Problem statement
- **Decision**: Chosen solution
- **Consequences**: Trade-offs, positive and negative impacts

---

## Records

### [ADR-001] Layered ORM and Database Driver Deduplication
- **Date**: 2026-09-12
- **Status**: Accepted
- **Context**: High-level ORMs (e.g. Mongoose, Prisma) execute on top of lower-level database drivers (MongoDB Native, PG, MySQL2). Instrumenting both layers simultaneously produces duplicate spans for a single logical query.
- **Decision**: Use an OpenTelemetry context suppression symbol (`PULSE_SUPPRESS_DB_DRIVER`) set by the logical layer to deterministically suppress lower driver spans while preserving standalone driver tracing when ORMs are not used.
- **Consequences**: Guarantees exactly one canonical span per database operation across both ORM and native driver code paths.
