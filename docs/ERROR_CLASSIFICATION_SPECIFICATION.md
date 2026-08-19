# Error Classification Contract Specification

## Overview

The Pulsiv Node.js SDK (`@vikasbaplawat1/pulse-sdk`) implements an explicit, deterministic, backward-compatible, and constant-time error classification model. The classification contract allows backend consumers (such as the Fast Lookup real-time alert evaluation engine) to reliably distinguish:

* **Handled Application Errors**
* **Unhandled Exceptions**
* **Fatal Infrastructure Errors**
* **Process Crashes**
* **Unhandled Promise Rejections**

---

## 1. Classification Matrix Contract

| Capture Path / Mechanism | Handled (`handled`) | Mechanism (`mechanism`) | Severity (`severity`) | Unhandled (`errors.unhandled`) | Fatal (`errors.fatal`) | Crash (`errors.crash`) | Target Fast Lookup Rule |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `captureError(err)` | `true` | `manual` | `error` | `false` | `false` | `false` | `none` (No alert) |
| `captureError(err, 'fatal')` | `true` | `manual` | `fatal` | `false` | `true` | `false` | `fatal_exception_fast` |
| Express `next(err)` | `true` | `express.next` | `error` | `false` | `false` | `false` | `none` (No alert) |
| Express `res.on('error')` | `true` | `express.res.error` | `error` | `false` | `false` | `false` | `none` (No alert) |
| Fastify `onError` | `true` | `fastify.onError` | `error` | `false` | `false` | `false` | `none` (No alert) |
| `uncaughtException` | `false` | `uncaughtException` | `fatal` | `true` | `true` | `true` | `process_crash_fast` |
| `unhandledRejection` | `false` | `unhandledRejection` | `error` | `true` | `false` | `false` | `unhandled_exception_fast` |
| `console.error` | `true` | `console.error` | `error` | `false` | `false` | `false` | `none` (No alert) |

---

## 2. Core Principles & Constraints

1. **Source of Truth Hierarchy**:
   - Classification derives strictly from the 3 fundamental telemetry facts: `handled`, `mechanism`, `severity`.
   - Never infer `fatal` or `crash` from error name, message text, stack trace patterns, HTTP status codes, route paths, or arbitrary metadata.
2. **Express Error Handling Semantics**:
   - `express.next` is **handled** (`handled: true`, `severity: 'error'`). Express routes catching an error and delegating to middleware/next are managed application flows and must **never** trigger `unhandled_exception_fast`.
3. **Deterministic & Constant Time**:
   - Classification is computed synchronously in $O(1)$ constant time with zero regex scanning or heuristic guessing.
4. **Wire Format Backward Compatibility**:
   - The SDK emits `classification: { unhandled, fatal, crash }` at the root of `ErrorEvent`.
   - The backend extraction pipeline supports both new payloads (`event.classification`) and legacy payloads (deriving `errors.*` fallback from `handled`, `mechanism`, `severity`).
5. **No Leaked Alert States in SDK**:
   - The SDK never computes alert states, evaluation counts, or notification cooldowns. The SDK's sole responsibility is emitting pure, deterministic event facts and classification signals.

---

## 3. Wire Payload Examples

### 3.1 Handled Express Route Error (`express.next`)
```json
{
  "type": "error",
  "name": "TypeError",
  "message": "Cannot read properties of null",
  "severity": "error",
  "mechanism": "express.next",
  "handled": true,
  "classification": {
    "unhandled": false,
    "fatal": false,
    "crash": false
  }
}
```

### 3.2 Manual Fatal Infrastructure Error (`captureError(err, 'fatal')`)
```json
{
  "type": "error",
  "name": "DatabaseDeadlockError",
  "message": "Connection pool exhausted",
  "severity": "fatal",
  "mechanism": "manual",
  "handled": true,
  "classification": {
    "unhandled": false,
    "fatal": true,
    "crash": false
  }
}
```

### 3.3 Genuine Uncaught Exception (`uncaughtException`)
```json
{
  "type": "error",
  "name": "ProcessCrash",
  "message": "Fatal segmentation fault",
  "severity": "fatal",
  "mechanism": "uncaughtException",
  "handled": false,
  "classification": {
    "unhandled": true,
    "fatal": true,
    "crash": true
  }
}
```

### 3.4 Unhandled Promise Rejection (`unhandledRejection`)
```json
{
  "type": "error",
  "name": "Error",
  "message": "Uncaught rejected promise in background queue",
  "severity": "error",
  "mechanism": "unhandledRejection",
  "handled": false,
  "classification": {
    "unhandled": true,
    "fatal": false,
    "crash": false
  }
}
```
