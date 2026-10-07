# Branching Strategy & Release Lifecycle Guide

## 1. Executive Overview

This document defines the standardized Git branching model, branch naming conventions, commit message standards, and environment promotion workflows for the `@pulse-apm/node` codebase.

All contributors and automated CI/CD pipelines must adhere strictly to these standards to maintain branch hygiene, auditable release lifecycles, and zero-downtime production deployments.

---

## 2. Standard Branch Hierarchy

```
[ feature/* ] ────────► develop ────────► staging ────────► pre-production ────────► main (Production)
                           ▲                                                      │
                           │                                                      ▼
                      [ bugfix/* ]                                           [ hotfix/* ] ──┐
                           ▲                                                      │         │
                           └──────────────────────────────────────────────────────┴─────────┘ (back-merge)
```

### Core Environment & Lifecycle Branches

| Branch | Classification | Purpose | Base Branch | Target Merge |
| :--- | :--- | :--- | :--- | :--- |
| `main` | Production | Production-ready, hardened code. Deploys directly to NPM / Production registry. Protected branch. | — | — |
| `pre-production` | Pre-Production / UAT | Final validation and rehearsal environment matching production infrastructure. | `staging` | `main` |
| `staging` | Staging / QA | Shared integration and end-to-end quality assurance verification environment. | `develop` | `pre-production` |
| `develop` | Development | Primary integration branch for ongoing development, sprint iterations, and verified features. | `main` | `staging` |
| `bugfix` | Maintenance Base | Baseline integration branch for non-critical defect fixes and stabilization patches. | `develop` | `develop` / `staging` |
| `hotfix` | Critical Patch Base | Baseline branch for urgent, critical production incident resolutions. | `main` | `main` & `develop` |

---

## 3. Ephemeral Branch Naming Conventions

When creating task-specific branches, developers must use standard lowercase hierarchical prefixes with hyphen-delimited slugs:

| Category | Branch Pattern | Example |
| :--- | :--- | :--- |
| **New Features** | `feature/<short-description>` | `feature/otel-metrics-export` |
| **Bug Fixes** | `bugfix/<issue-id>-<description>` | `bugfix/issue-104-event-loop-lag` |
| **Hot Fixes** | `hotfix/<cve-or-incident>-<description>` | `hotfix/cve-2026-auth-header-leak` |
| **Refactoring** | `refactor/<subsystem-scope>` | `refactor/transport-batch-pooling` |
| **Documentation** | `docs/<topic-scope>` | `docs/express-fastify-guide` |
| **Chores / Tooling** | `chore/<task-scope>` | `chore/update-typescript-configs` |

---

## 4. Professional Commit Message Standards

All commit messages must adhere to the [Conventional Commits 1.0.0](https://www.conventionalcommits.org/) specification.

### Commit Format

```
<type>(<optional-scope>): <imperative subject>

[optional body explaining motivation, rationale, and technical changes]

[optional footer(s) for issue references or breaking change notices]
```

### Allowed Types

- `feat`: A new user-facing or SDK feature
- `fix`: A bug fix or defect remediation
- `docs`: Documentation changes only
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `perf`: Performance optimization or resource reduction
- `test`: Adding or correcting tests without production code changes
- `chore`: Tooling, workflow, dependency, or configuration updates
- `ci`: CI/CD pipeline or automation script modifications

### Examples

**Professional (Approved):**
- `feat(transport): introduce ring-buffer fallback under backpressure`
- `fix(instrumentation): prevent uncaught exception on malformed fastify routes`
- `refactor(core): streamline client initialization and validation lifecycle`
- `docs(api): synchronize method naming with industry standards`
- `chore(deps): bump opentelemetry dependencies to 2.11.0`

**Informal / Unacceptable (Prohibited):**
- ❌ `sdk bug fix`
- ❌ `final sdk version`
- ❌ `updated code`
- ❌ `compiles ts code`
- ❌ `fixing things that broke`

---

## 5. Promotion & Release Workflow

1. **Feature Ingestion:** Features merge via Pull Request into `develop` after passing all unit tests and peer review.
2. **Staging Promotion:** `develop` is merged into `staging` for automated regression testing and soak testing.
3. **Pre-Production Staging:** Validated changes advance from `staging` to `pre-production` for load audits and final staging sign-off.
4. **Production Release:** `pre-production` is merged into `main`. The release is tagged with semantic versioning (`vX.Y.Z`) and published.
5. **Emergency Hotfixes:** Hotfixes are branched directly from `main`, verified under isolated testing, merged back into `main`, and back-merged immediately into `develop` and `staging`.
