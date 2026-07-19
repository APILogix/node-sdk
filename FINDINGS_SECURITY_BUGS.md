# Security Bugs / Findings — sdk-node

> **Status:** All findings in this document have been remediated. See [`FIXES.md`](./FIXES.md) for implementation details and verification.

This document lists security defects found in the `sdk-node` SDK. Each finding includes severity, location, evidence, and impact.

## P0 — API Key Sent in Request Body (Legacy `sender.ts`)

- **File:** `src/transport/sender.ts`
- **Line:** `createIngestPayload()` returns `{ apiKey, events }` and `sendInitRequest()` posts `{ apiKey }`.
- **Impact:** The API key is sent in the HTTP body as well as the `Authorization` header. Bodies are commonly logged by proxies, application servers, and error handlers. If a request body is ever captured as a span attribute or breadcrumb, the key leaks into the telemetry pipeline itself.
- **Fix:** Move the key to the `Authorization: Bearer <key>` header only; remove `apiKey` from the payload body. The init handshake body is also cleared.  
  **Status:** Fixed.

## P1 — Fastify `request.ip` Bypasses IP Masking

- **File:** `src/instrumentation/fastify.ts`
- **Line:** `const clientIp = request.ip ?? resolveClientIp(...)`
- **Impact:** `request.ip` is used directly when Fastify's `trustProxy` setting resolves it. The `maskIp` decision from `evaluateCaptureGate()` is ignored, so a real client IP can be attached to the request event and propagated to breadcrumbs / scope even when remote config demands masking.
- **Fix:** Always route `request.ip` through `resolveClientIp()` with `decision.maskIp` set to `true` so it is hashed before storage.  
  **Status:** Fixed.

## P1 — Error Messages and Scope User Data Are Not Scrubbed

- **Files:** `src/capture/captureError.ts`, `src/core/scope.ts`, `src/core/context.ts`
- **Evidence:** `captureError.ts` sets `event.message = normalized.message` without scrubbing. `scope.ts` stores `user.email`, `user.ipAddress`, `user.username` as plain strings and copies them into events. Breadcrumbs captured from request context may contain raw IPs, tokens, or emails.
- **Impact:** PII/PHI in error messages or user context reaches the backend unredacted, violating GDPR/CCPA/PCI commitments.
- **Fix:** Scrub `error.message` through `SecurityScrubber.scrubValue()` before creating the event. Apply `sanitizeString()` to user `email`, `username`, and `ipAddress` in `ScopeManager`. Run all breadcrumbs through the scrubber before attachment.  
  **Status:** Fixed.

## P1 — Breadcrumbs Accumulate Sensitive Data Unscrubbed

- **Files:** `src/core/context.ts`, `src/core/breadcrumb.ts`, `src/capture/captureError.ts`
- **Impact:** Breadcrumbs are captured from console, navigation, and request events and then attached to error events. No central scrubbing is applied before the breadcrumb buffer is consumed.
- **Fix:** Add a `scrubBreadcrumbs()` helper in `SecurityScrubber` and call it when extracting context breadcrumbs for capture.  
  **Status:** Fixed.

## P1 — Prototype Pollution in Scope and Sanitizer

- **Files:** `src/core/scope.ts`, `src/processors/sanitizer.ts`, `src/instrumentation/request-capture-utils.ts` (`fallbackScrubBody`)
- **Evidence:**
  - `scope.ts` `setTags()`, `setExtras()`, `setContext()` use `Object.entries()` and copy into `this.tags[key]`, `this.extra[key]`, `this.contexts[name]` without `Object.create(null)` or `__proto__` checks.
  - `sanitizer.ts` `sanitizeObject()` iterates `Object.keys()` and assigns to `result[key]` using a plain object.
  - `fallbackScrubBody` parses JSON and assigns nested properties without sanitizing keys or using null-prototype objects.
- **Impact:** An attacker who can influence a tag/context/breadcrumb key (e.g., via query parameter) can set `__proto__`, `constructor`, or `prototype` properties, leading to prototype pollution across the SDK and host application.
- **Fix:** Use null-prototype objects for all maps and reject / escape keys that match `__proto__`, `constructor`, `prototype` before assignment.  
  **Status:** Fixed.

## P1 — Source-Map Resolver Follows Redirects (SSRF Risk)

- **File:** `src/processors/source-map-resolver.ts`
- **Evidence:** The fetch used to download source maps likely follows redirects by default. If a stack frame filename is attacker-controlled (e.g., `file://` or an internal metadata URL), the SDK can be coerced into requesting internal services or local files.
- **Impact:** Server-Side Request Forgery (SSRF) from error stack trace data.
- **Fix:** Disable redirect following in the source-map fetch and reject non-`http/https:` protocols. Cap download size and timeout.  
  **Status:** Fixed.

## P1 — Raw API Key in `sender.ts` Init Request Body

- **File:** `src/transport/sender.ts`
- **Line:** `return postJson<InitResponse>(joinUrl(baseUrl, '/v1/init'), { apiKey }, {}, timeoutMs, ...)`
- **Impact:** Same as P0; the init handshake exposes the key in the body.
- **Fix:** Send the key in the `Authorization` header and an empty body (or a minimal non-secret body).  
  **Status:** Fixed.

## P2 — Instrumentations Do Not Scrub Captured Payloads

- **Files:** `src/instrumentation/axios.ts`, `src/instrumentation/redis.ts`, `src/instrumentation/mongo.ts`, `src/instrumentation/bullmq.ts`
- **Impact:** Auto-instrumentations capture request/response bodies, headers, and query strings without running them through `SecurityScrubber`. Redis commands, MongoDB queries, and BullMQ job payloads can contain tokens, emails, or PII.
- **Fix:** Centralize all captured payload construction through `SecurityScrubber.scrubValue()` or `sanitizeEvent()` before enqueuing the event.  
  **Status:** Fixed.

## P2 — Response-Body Preview in HTTP Transport Is Not Scrubbed

- **File:** `src/transport/http.ts`
- **Impact:** Error-path logging includes response body snippets for debugging; these may contain backend secrets.
- **Fix:** Apply `SecurityScrubber.scrubValue()` to the response-body preview before logging.  
  **Status:** Fixed.

## P2 — Source Context Lines Sent Raw

- **File:** `src/processors/source-context.ts`
- **Impact:** Pre/post source lines attached to error events may contain hard-coded secrets, SQL, or PII inline in source code.
- **Fix:** Run each source line through `SecurityScrubber.scrubValue()` before embedding in the event.  
  **Status:** Fixed.

## P2 — Temporary / Persistent Storage Files Are World-Readable

- **Files:** `src/storage/persistent-storage.ts`, `src/storage/*.ts`
- **Impact:** Disk-persisted events contain raw error data and may be readable by other users on the host.
- **Fix:** Create files with `0o600` permissions and validate on read.  
  **Status:** Fixed.

## P3 — Stack Parser Regex Can Consume Huge Inputs

- **File:** `src/processors/stack-parser.ts`
- **Impact:** The regex fallback for pre-serialized stacks has no length/line cap and can hang the event loop on malicious input.
- **Fix:** Cap input to 64 k characters / 500 lines before running the regex fallback.  
  **Status:** Fixed.

## P3 — `X-pulse-internal` Header Is Static and Not Authenticated

- **Files:** `src/transport/batch-manager.ts`, `src/transport/http.ts`
- **Impact:** The internal marker is a fixed string and can be spoofed by any caller; it provides no security boundary.
- **Fix:** Document it as a routing hint only; rely on signed `Authorization` header for authentication.  
  **Status:** Documented.
