# SDK-Node Audit Index

This directory contains the enterprise audit of `sdk-node` performed against the codebase at `C:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node`. The audit covers four lenses: security defects, performance defects, remote-config feature management, and the event types sent to the backend. A companion `FIXES.md` file records the remediation applied.

## Files

| File | Scope |
|------|-------|
| [FINDINGS_SECURITY_BUGS.md](./FINDINGS_SECURITY_BUGS.md) | Data leaks, PII, header smuggling, SSRF, prototype pollution, secret handling |
| [FINDINGS_PERFORMANCE_BUGS.md](./FINDINGS_PERFORMANCE_BUGS.md) | Hot-path CPU/memory waste, serialization duplication, unbounded buffers, ignored config |
| [FINDINGS_FEATURES_REMOTE_MANAGEMENT.md](./FINDINGS_FEATURES_REMOTE_MANAGEMENT.md) | Features advertised by the remote config but not wired; entitlement gaps |
| [FINDINGS_BACKEND_EVENT_TYPES.md](./FINDINGS_BACKEND_EVENT_TYPES.md) | Every event type emitted, route, schema notes, and backend contract |
| [FIXES.md](./FIXES.md) | What was changed, why, and verification status |

## Severity Legend

- **P0 (Critical)** — Data leak, crash, unbounded resource growth, or remote SDK bypass.
- **P1 (High)** — Production reliability issue, security control absent, measurable performance regression.
- **P2 (Medium)** — Defensive gap, inconsistent behavior, tech debt.
- **P3 (Low)** — Cleanup, naming, documentation drift.

## Audit Scope

- Only `sdk-node` source code is reviewed and modified.
- `pulse-mock-backend/` is intentionally excluded per product requirement.
- The TypeScript build is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
