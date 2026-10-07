# Telemetry Payload Compression

## 1. Overview

Telemetry payloads consist largely of repetitive structured JSON (timestamps, trace IDs, URLs, stack frames), making them ideal candidates for compression. Compression reduces network bandwidth, speeds up HTTP transmissions, and minimizes egress costs.

Compression utilities reside in [`src/utils/compression.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/utils/compression.ts).

---

## 2. Supported Compression Formats

Pulse supports two standard HTTP compression algorithms alongside uncompressed transmission:

| Algorithm | HTTP `Content-Encoding` | Typical Ratio | CPU Cost | Target Use Case |
|---|---|---|---|---|
| **Gzip** | `gzip` | 80% – 90% | Low | Default for all standard telemetry routes. |
| **Brotli** | `br` | 85% – 95% | Medium | Large offline disk spools and replay streams. |
| **None** | `identity` | 0% | Zero | Single-event immediate routes (`/v1/crons`). |

---

## 3. Worker-Thread Compression Pipeline

Compressing large multi-megabyte payloads in the main V8 isolate can create measurable event-loop latency.

To eliminate main-thread blocking:
1. Payloads exceeding 50KB are dispatched to the `SerializationPool` worker thread.
2. The worker thread performs serialization and compression sequentially inside its isolated thread space.
3. The compressed binary `Buffer` is transferred back to the main thread via zero-copy `ArrayBuffer` transfer lists.
4. The main thread immediately dispatches the pre-compressed buffer via HTTP.

---

## 4. Error Fallback

If `zlib.gzip` or `zlib.brotliCompress` fails due to corrupted memory or buffer limits, the transport layer catches the error, falls back to uncompressed JSON transmission, and logs a debug diagnostic without dropping the telemetry batch.
