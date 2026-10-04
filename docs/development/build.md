# Build Pipeline & Distribution Separation

## 1. Overview

`@pulse-apm/node` employs a strict separation between source code, documentation, and the compiled distribution package.

---

## 2. Compilation Architecture

The build is driven by TypeScript (`tsconfig.json`):

```json
{
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "module": "nodenext",
    "target": "esnext",
    "declaration": true,
    "strict": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests", "docs"]
}
```

### Build Steps:
1. **Clean (`npm run clean`):** Deletes existing `./dist/` directory and removes any stray artifacts in `./src/`.
2. **Compile (`npx tsc`):** Compiles TypeScript files from `./src/` directly to `./dist/`.

---

## 3. Distribution Separation Invariants

### 3.1 Documentation Excluded from `dist/`
- Documentation files (`docs/`, `*.md`, `*.mdx`) are strictly excluded from the TypeScript build.
- `dist/` contains **only**:
  - Compiled JavaScript files (`.js`)
  - Type declaration files (`.d.ts`)
  - Internal worker scripts (`serialization-worker.js`)

### 3.2 NPM Package Whitelist
In `package.json`:

```json
"files": [
  "dist/**/*",
  "!dist/internals.*"
]
```

When publishing to npm or packing via `npm pack`:
- Only `dist/` artifacts and the root `README.md` are packaged.
- The `docs/` folder, test suites, and internal tools are never packaged into the distribution tarball.

### 3.3 Verification Command:
```bash
npm pack --dry-run
```
Verifies that only `dist/` files and package metadata appear in the tarball manifest.
