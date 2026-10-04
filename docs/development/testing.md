# Testing Guidelines & Test Development

## 1. Running Tests

Testing uses TypeScript compilation to a separate `dist-tests/` directory to prevent polluting production `dist/`:

```bash
# 1. Compile test code
npx tsc -p tsconfig.test.json

# 2. Run unit tests
node --test dist-tests/tests/unit/*.test.js

# 3. Run integration & adversarial tests
node --test dist-tests/tests/integration/*.test.js
```

---

## 2. Writing Unit Tests

When adding a unit test:
1. Place the test under `tests/unit/` using the `.test.ts` extension.
2. Use Node.js native test runner imports (`import { describe, it, beforeEach, afterEach } from 'node:test'`).
3. Use strict assertion utilities (`import assert from 'node:assert/strict'`).
4. Always invoke `await shutdown()` in `afterEach` to ensure background timers and worker threads are cleared.

---

## 3. Writing Integration Tests

Integration tests should test real behavior:
- Mock the control plane (`/v1/init`) using `globalThis.fetch` overrides or a local HTTP server.
- Test error boundary containment: simulate network failure, 500 errors, or socket resets.
- Use `monitorEventLoopDelay` to ensure event-loop lag remains under 50ms during high-volume operations.
