# Telemetry Context Enrichment

## 1. Overview

Raw events are automatically enriched with contextual environmental and runtime metadata before leaving the host process.

Enrichment bridges infrastructure diagnostics with code execution, enabling developers to correlate bugs with specific Kubernetes pods, cloud availability zones, Git releases, or user sessions.

---

## 2. Resource & Cloud Detection

The `ResourceDetector` in [`src/utils/resource-detector.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/resource-detector.ts) automatically extracts cloud metadata during startup:

- **Kubernetes:** Pod name (`HOSTNAME`), Namespace (`/var/run/secrets/kubernetes.io/serviceaccount/namespace`), Container ID (via `/proc/self/cgroup`).
- **AWS ECS / Fargate:** Task ARN, Cluster ARN, Container ID via ECS metadata endpoints.
- **Docker:** Container ID via cgroup parsing.
- **Process Info:** `process.pid`, Node.js version, platform (`linux`, `darwin`, `win32`), architecture (`x64`, `arm64`).

---

## 3. Git Release & Version Detection

Release versions are detected using hierarchical fallback rules:
1. Explicit option passed to `init({ release: '1.2.0' })`
2. `PULSE_RELEASE` environment variable
3. Git Commit SHA from environment (`GIT_COMMIT_SHA`, `COMMIT_REF`, `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`)
4. Package metadata (`package.json` version via `src/utils/package-metadata.ts`)

---

## 4. User Identity & Scope Metadata

Application code can enrich in-flight telemetry dynamically:

```typescript
import { setUser, setTag, setContext } from '@pulse-apm/node';

// Attach user identity
setUser({
  id: 'user_10293',
  email: 'dev@company.com',
  username: 'developer123',
});

// Attach custom tags
setTag('environment.tier', 'frontend-edge');

// Attach structured business context
setContext('subscription', {
  plan: 'enterprise',
  seats: 50,
  renewalDate: '2027-01-01',
});
```
