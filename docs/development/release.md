# Release Process & Versioning

## 1. Semantic Versioning

`@pulse-apm/node` follows strict [Semantic Versioning (SemVer 2.0.0)](https://semver.org/):

- **Major (X.0.0):** Breaking changes to the public API contract in `src/index.ts` or raised minimum Node.js runtime engine version.
- **Minor (0.X.0):** New backward-compatible features, auto-instrumentation drivers, or configuration options.
- **Patch (0.0.X):** Backward-compatible bug fixes, performance optimizations, and reliability hardening.

---

## 2. Pre-Release Verification Checklist

Before publishing a release:

1. **Verify All Tests Pass:**
   ```bash
   npm test
   ```
2. **Build Distribution:**
   ```bash
   npm run build
   ```
3. **Inspect Distribution Separation:**
   ```bash
   npm pack --dry-run
   ```
   - Confirm only `dist/` and package metadata files exist in the tarball.
   - Confirm zero `.md` or `docs/` files are present.
4. **Git Commit & Tag:**
   ```bash
   git commit -am "chore: release v8.4.5"
   git tag v8.4.5
   git push origin main --tags
   ```

---

## 3. Publishing to NPM

```bash
npm publish --access public
```

The `prepublishOnly` lifecycle hook automatically invokes `npm run build` prior to packing, ensuring that distribution artifacts are never published from stale builds.
