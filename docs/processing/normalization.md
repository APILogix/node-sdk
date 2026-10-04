# Event Normalization

## 1. Overview

Before telemetry records can be queued or serialized, they pass through the `Normalizer` in [`src/processors/normalizer.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/normalizer.ts).

Normalization ensures data consistency, prevents serialization crashes (e.g., circular object references), and guarantees predictable payload memory footprints.

---

## 2. Normalization Tasks

### 2.1 UUID & High-Resolution Timestamps
- Assigns a cryptographically unique `eventId` (UUIDv4).
- Computes both standard wall-clock ISO 8601 UTC timestamp and monotonic high-resolution millisecond offsets via `process.hrtime.bigint()`.

### 2.2 Error Object Standardization
In JavaScript, any type can be thrown: `throw "string"`, `throw 404`, or `throw { custom: "error" }`. The normalizer converts arbitrary thrown values into standardized `ErrorEvent` objects:
- **String / Number:** Wrapped into an `Error` instance with synthesis message.
- **Plain Object:** Properties extracted and assigned to `error.attributes`.
- **Circular References:** Detected and replaced with `"[Circular]"` markers using a WeakSet visitor.

### 2.3 Field Bounding & Truncation
To prevent rogue loggers or multi-megabyte error dumps from exhausting memory:
- **Max String Length:** Strings exceeding 16,384 characters are truncated with an ellipsis.
- **Max Array Length:** Arrays exceeding 250 elements are sliced.
- **Max Object Depth:** Nested structures are bounded to 10 traversal levels. Excess depths are replaced with `"[DepthLimitExceeded]"`.
