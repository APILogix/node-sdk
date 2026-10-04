# Local Development Guide

## 1. Prerequisites

- **Node.js:** `>= 18.19.0` (or Node.js `>= 20.6.0` recommended for native ESM `--import`).
- **Package Manager:** `npm` v9+.
- **TypeScript:** v5.0+.

---

## 2. Setup & Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/pulse-apm/pulse-sdk-node.git
cd pulse-sdk-node
npm install
```

---

## 3. Project Scripts

| Script | Command | Purpose |
|---|---|---|
| **`npm run build`** | `npm run clean && npx tsc` | Compiles TypeScript source to `./dist/`. |
| **`npm run clean`** | Node.js inline script | Deletes `./dist/` and any stray `.js`/`.d.ts` files in `./src/`. |
| **`npm test`** | `npm run test:unit && npm run test:integration` | Runs full unit and integration test suites. |
| **`npm run test:unit`** | `node --test dist-tests/tests/unit/*.test.js` | Runs unit tests using Node.js native test runner. |
| **`npm run test:integration`** | `node --test dist-tests/tests/integration/*.test.js` | Runs integration and adversarial test suites. |
| **`npm run dev`** | `nodemon src/index.ts` | Local development watcher. |
| **`npm run prepublishOnly`** | `npm run build` | Pre-publish compilation safety check. |
