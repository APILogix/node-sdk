# Sensitive Data Handling & Local Storage Security

## 1. Transport Encryption

All network communications between the Pulse SDK and the control-plane / ingestion servers use HTTPS with Transport Layer Security (TLS 1.2 or TLS 1.3). Plaintext HTTP is rejected in production environments.

---

## 2. Local Storage File Permissions

When local offline spooling or configuration caching is enabled (`src/storage/persistent-storage.ts`, `src/storage/config-cache.ts`):
- **Directory Permissions:** Spool directories are created with restricted POSIX mode `0o700` (`rwx------`), restricting access strictly to the operating system user running the Node.js process.
- **File Permissions:** Telemetry spool files and configuration cache files are written with mode `0o600` (`rw-------`).
- **Encrypted Local Buffers:** Telemetry payloads written to disk can be encrypted using AES-256-GCM if local encryption keys are configured.

---

## 3. In-Memory Retention & De-Referencing

To prevent retained sensitive objects from remaining in process memory:
- Raw HTTP request/response stream references are dereferenced immediately after extracting status codes and timing headers.
- Processed telemetry batches are evicted and unreferenced immediately upon transmission, making the memory available for V8 garbage collection.
- Source maps and stack traces are cached in bounded LRU maps to avoid unbounded memory growth.
