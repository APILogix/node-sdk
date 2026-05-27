# SDK-NODE ENTERPRISE-GRADE ARCHITECTURE ANALYSIS

## PHASE 7 — SECURITY & DATA SAFETY

This document is a complete security and data safety audit of the Pulse SDK (`sdk-node`). Every finding is backed by direct source code evidence. Intended for security engineers, compliance teams, and platform architects evaluating production data safety.

---

## TABLE OF CONTENTS

1. [Security Architecture Overview](#1-security-architecture-overview)
2. [Sensitive Data Leakage Analysis](#2-sensitive-data-leakage-analysis)
3. [PII Masking — Deep Analysis](#3-pii-masking--deep-analysis)
4. [Header Sanitization](#4-header-sanitization)
5. [Token Leakage Risks](#5-token-leakage-risks)
6. [Payload Encryption & Transport Security](#6-payload-encryption--transport-security)
7. [Compression Bomb Risks](#7-compression-bomb-risks)
8. [Unsafe Serialization](#8-unsafe-serialization)
9. [Prototype Pollution Risks](#9-prototype-pollution-risks)
10. [Config Injection Risks](#10-config-injection-risks)
11. [Cryptographic Primitives Audit](#11-cryptographic-primitives-audit)
12. [Data Flow Security Map](#12-data-flow-security-map)
13. [Security Findings Summary](#13-security-findings-summary)

---

---

## 1. SECURITY ARCHITECTURE OVERVIEW

### 1.1 Defense-in-Depth Layers

The SDK implements security at five independent layers:

```
Layer 1: Capture Gate (request-capture-utils.ts)
  → Early rejection before any allocation
  → Fallback scrubbing when SecurityScrubber not yet initialized

Layer 2: Normalizer (normalizer.ts)
  → Prototype pollution key blocking (__proto__, constructor, prototype)
  → Circular reference detection (WeakSet cycle guard)
  → String truncation (prevents oversized payloads)

Layer 3: Sanitizer / ApiPayloadScrubber (sanitizer.ts)
  → PII pattern matching (email, card, SSN, phone, Bearer tokens)
  → Sensitive key redaction (password, secret, token, api_key, ...)
  → Header scrubbing (authorization, cookie, x-api-key, ...)
  → Depth-bounded recursive traversal

Layer 4: SecurityScrubber (security-scrubber.ts)
  → Remote-config-driven scrubbing rules (hot-swappable)
  → PII detection (email, phone, IPv4)
  → URL query string scrubbing
  → Prototype pollution key blocking (DANGEROUS_KEYS set)
  → Object.create(null) for output objects (no prototype chain)

Layer 5: PipelineSpanExporter (tracer.ts)
  → privacy.capture.* gates (headers, body, query, cookies, response)
  → Attribute count limits (maxSpanAttributes)
  → Attribute value length limits (maxAttributeLength)
```

### 1.2 Security Processing Order

```
User event (captureError / captureRequest / span)
        │
        ▼
[Layer 1] CaptureGate — early rejection, fallback scrub
        │
        ▼
[Layer 2] normalizeEvent() — truncation, cycle guard, proto-pollution block
        │
        ▼
[Layer 3] sanitizeEvent() — PII patterns, sensitive key redaction
        │
        ▼
[Layer 4] SecurityScrubber.scrub() — remote-config rules, PII detection
        │
        ▼
[Layer 5] PipelineSpanExporter — privacy.capture.* gates (spans only)
        │
        ▼
Transport → Backend Ingestion API (HTTPS)
```

### 1.3 Security Ownership Matrix

| Data Type | Scrubbed By | Configurable | Hot-Swappable |
|-----------|------------|-------------|--------------|
| HTTP headers (auth, cookie) | Sanitizer + SecurityScrubber | Yes (remote config) | Yes |
| Request body fields | SecurityScrubber | Yes (remote config) | Yes |
| URL query parameters | SecurityScrubber | Yes (remote config) | Yes |
| Email addresses | SecurityScrubber (PII) | Yes (remote config) | Yes |
| Phone numbers | SecurityScrubber (PII) | Yes (remote config) | Yes |
| IPv4 addresses | SecurityScrubber (PII) | Yes (remote config) | Yes |
| Bearer tokens | Sanitizer (pattern) | No (hardcoded) | No |
| Credit card numbers | Sanitizer (pattern) | No (hardcoded) | No |
| SSN | Sanitizer (pattern) | No (hardcoded) | No |
| Span attributes (headers) | PipelineSpanExporter | Yes (privacy.capture) | Yes |
| Span body attributes | PipelineSpanExporter | Yes (privacy.capture) | Yes |
| Prototype pollution keys | Normalizer + SecurityScrubber | No (hardcoded) | No |

---

## 2. SENSITIVE DATA LEAKAGE ANALYSIS

### 2.1 Data Leakage Vectors

**Vector 1: User-supplied `context` in `captureError()`**

```typescript
captureError(err, {
    context: {
        user: { email: 'alice@example.com', password: 'hunter2' },
        apiKey: 'sk-prod-abc123',
        creditCard: '4111-1111-1111-1111'
    }
})
```

**Processing chain:**
1. `normalizeEvent()` — truncates strings, blocks `__proto__` keys
2. `sanitizeEvent()` — `isSensitiveKey('password')` → `[REDACTED]`, `isSensitiveKey('apiKey')` → `[REDACTED]`
3. `SecurityScrubber.scrub()` — `sensitiveFields.has('password')` → `[Redacted]`, PII patterns on email → `[email]`, card → `[card]`

**Result:** `password`, `apiKey`, `creditCard` redacted. Email replaced with `[email]`.

**Verdict: PASS** for known sensitive key names. **RISK** for unknown custom field names (e.g., `mySecretValue`).

**Vector 2: Span attributes from OTel auto-instrumentation**

OTel's `HttpInstrumentation` automatically captures:
- `http.request.header.authorization` — Bearer token
- `http.request.header.cookie` — session cookies
- `http.request.body` — request body
- `http.response.body` — response body

**Processing chain (PipelineSpanExporter):**
```typescript
const capture = ConfigManager.getInstance().getConfig().privacy?.capture
    ?? { headers: false, body: false, response: false, query: true, cookies: false }

if (!capture.headers) {
    filteredAttrs = Object.fromEntries(
        Object.entries(filteredAttrs).filter(([k]) =>
            !k.startsWith('http.request.header.') && !k.startsWith('http.response.header.')
        )
    )
}
if (!capture.body) {
    delete filteredAttrs['http.request.body']
    delete filteredAttrs['http.response.body']
}
if (!capture.cookies) {
    delete filteredAttrs['http.request.header.cookie']
    delete filteredAttrs['http.request.header.set-cookie']
}
```

**Default values:** `headers: false`, `body: false`, `cookies: false` — all sensitive span attributes are stripped by default.

**Verdict: PASS.** Headers, body, and cookies are NOT captured by default. Operators must explicitly enable them via remote config.

**Vector 3: Breadcrumbs containing sensitive data**

```typescript
addBreadcrumb({
    category: 'auth',
    message: 'Login attempt',
    data: { password: 'hunter2', token: 'Bearer abc123' }
})
```

Breadcrumbs are attached to error events via `enrichFromContext()`. They pass through `sanitizeEvent()` which applies PII patterns to string values and `isSensitiveKey()` to object keys.

**Risk: MEDIUM.** Breadcrumb `data` fields are scrubbed by key name (`password`, `token`) but only if the key matches the sensitive key pattern. Arbitrary key names like `myToken` would NOT be scrubbed.

### 2.2 Data Leakage via Logging

**File:** `src/transport/http.ts`

```typescript
console.log('HTTP response received', { response })
```

**CRITICAL FINDING:** There is a `console.log` statement in `http.ts` that logs the raw HTTP response object. This could expose:
- Response headers (including `Set-Cookie`, rate limit headers)
- Response body (which may contain sensitive data from the backend)

**Severity: HIGH.** This is a debug statement that should be `logger.debug()` and should NOT log the full response object.

### 2.3 Data Leakage via SDK Internal Logs

The SDK uses `getLogger()` for internal logging. Log output goes to `process.stderr` (not `console.error`). Log levels are controlled by `LOG_LEVEL` environment variable.

**Risk:** At `debug` level, the SDK logs:
- HTTP endpoint URLs (may contain API keys in query params)
- Event counts and queue sizes
- Compression ratios

**Verdict: LOW RISK.** Debug logs are not enabled by default. URLs are logged but not full payloads.

---

## 3. PII MASKING — DEEP ANALYSIS

### 3.1 Two-Layer PII System

The SDK has two independent PII masking systems:

**System 1: `ApiPayloadScrubber` (sanitizer.ts)** — hardcoded patterns, always active
**System 2: `SecurityScrubber` (security-scrubber.ts)** — remote-config-driven, hot-swappable

### 3.2 Hardcoded PII Patterns (ApiPayloadScrubber)

**File:** `src/processors/sanitizer.ts`

```typescript
function createPiiPatterns(): ReadonlyArray<{ pattern: RegExp; replacement: string }> {
    return [
        // Email addresses
        { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
          replacement: '[email]' },

        // Credit card numbers (16 digits with optional separators)
        { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
          replacement: '[card]' },

        // US Social Security Numbers
        { pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
          replacement: '[ssn]' },

        // US Phone numbers
        { pattern: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
          replacement: '[phone]' },

        // Bearer tokens
        { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
          replacement: 'Bearer [REDACTED]' },

        // Key=value pairs in query strings
        { pattern: /(api[-_]?key|token|authorization|password|secret)=([^&\s]+)/gi,
          replacement: '$1=[REDACTED]' },
    ]
}
```

**Coverage analysis:**

| PII Type | Pattern | False Positive Risk | False Negative Risk |
|----------|---------|--------------------|--------------------|
| Email | RFC-5321 subset | Low | Low (misses punycode) |
| Credit card | 16-digit groups | Medium (phone numbers) | Medium (Amex 15-digit) |
| SSN | `XXX-XX-XXXX` | Low | High (no dashes format) |
| Phone | US format only | Medium | High (international) |
| Bearer token | `Bearer ` prefix | None | None |
| Query params | Key=value | None | Medium (custom key names) |

**Gaps:**
- **International phone numbers** not covered (non-US formats)
- **SSN without dashes** (`123456789`) not covered
- **Amex cards** (15 digits) not covered
- **IPv6 addresses** not covered
- **Passport numbers** not covered
- **IBAN/bank account numbers** not covered

### 3.3 Remote-Config PII Patterns (SecurityScrubber)

**File:** `src/processors/security-scrubber.ts`

```typescript
private static readonly EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
private static readonly PHONE_PATTERN = /(\+?1?\s*[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g
private static readonly IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g
```

These patterns are applied when `piiConfig.enabled = true` AND the respective flag is set:
- `piiConfig.maskEmails` → apply `EMAIL_PATTERN`
- `piiConfig.maskPhones` → apply `PHONE_PATTERN`
- `piiConfig.maskIPs` → apply `IPV4_PATTERN`

**Hot-swap:** When remote config changes, `handleConfigChange()` updates the PII config immediately. The next event processed uses the new rules.

### 3.4 PII Masking Depth Limits

Both scrubbers have depth limits to prevent infinite recursion:

```typescript
// sanitizer.ts
const MAX_SANITIZE_DEPTH = 10

// security-scrubber.ts
private scrubBodyFields(obj, depth = 0): Record<string, unknown> {
    if (depth > 10) return obj  // ← stops at depth 10
}
```

**Risk: MEDIUM.** PII nested deeper than 10 levels is NOT scrubbed. In practice, user-supplied context rarely exceeds 5 levels, but deeply nested objects (e.g., from ORM query results) could contain PII at depth > 10.

### 3.5 PII Masking Flow Diagram

```mermaid
flowchart TD
    A[Event with potential PII] --> B[ApiPayloadScrubber.sanitizeEvent]
    B --> C{event.type?}
    C -->|request| D[scrubRequestEvent\nscrubHeaders + body]
    C -->|span| E[scrubSpanEvent\nOTel header attrs]
    C -->|other| F[skip explicit scrub]
    D --> G[sanitizeValue — deep scan]
    E --> G
    F --> G
    G --> H{String value?}
    H -->|Yes| I[Apply 6 PII patterns\nemail, card, SSN, phone, Bearer, query]
    H -->|No — object| J{isSensitiveKey?}
    J -->|Yes| K[Replace with REDACTED]
    J -->|No| L[Recurse — depth limit 10]
    I --> M[SecurityScrubber.scrub]
    K --> M
    L --> M
    M --> N{hasScrubRules?}
    N -->|No| O[Return event unchanged]
    N -->|Yes| P[scrubHeaders + scrubQueryParams\nscrubUrlQueryString + scrubBodyFields]
    P --> Q{piiConfig.enabled?}
    Q -->|Yes| R[scrubPiiInObject\nemail/phone/IP patterns]
    Q -->|No| S[Skip PII scan]
    R --> T[Scrubbed event]
    S --> T
    O --> T
```

---

## 4. HEADER SANITIZATION

### 4.1 Default Sensitive Headers

**File:** `src/processors/sanitizer.ts`

```typescript
const DEFAULT_SENSITIVE_HEADERS = [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'proxy-authorization'
]
```

**File:** `src/instrumentation/request-capture-utils.ts`

```typescript
const FALLBACK_SENSITIVE_HEADER_PATTERN = /^(
    authorization|proxy-authorization|cookie|set-cookie|
    x-api-key|x-auth-token|x-csrf-token|x-session-token|
    api-key|access-token|refresh-token
)$/i
```

The fallback pattern (used before `SecurityScrubber` is initialized) covers more headers than the default list.

### 4.2 Header Scrubbing Implementation

**File:** `src/processors/security-scrubber.ts`

```typescript
private scrubHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)  // ← no prototype
    for (const [key, value] of Object.entries(headers)) {
        if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue  // ← proto-pollution block
        result[key] = this.sensitiveHeaders.has(key.toLowerCase()) ? REDACTED : value
    }
    return result
}
```

**Key security properties:**
1. `Object.create(null)` — output has no prototype chain (prevents prototype pollution via output)
2. `DANGEROUS_KEYS` check — blocks `__proto__`, `constructor`, `prototype` as header names
3. Case-insensitive matching — `Authorization` and `authorization` both scrubbed

### 4.3 OTel Span Header Attributes

**File:** `src/tracing/tracer.ts` — `PipelineSpanExporter.spanToEvent()`

OTel's `HttpInstrumentation` captures headers as span attributes with the naming convention `http.request.header.{name}`:

```typescript
if (!capture.headers) {
    filteredAttrs = Object.fromEntries(
        Object.entries(filteredAttrs).filter(([k]) =>
            !k.startsWith('http.request.header.') &&
            !k.startsWith('http.response.header.')
        )
    )
}
```

**Default:** `capture.headers = false` — ALL request and response header attributes are stripped from spans by default.

**When enabled:** Individual sensitive headers are still scrubbed by `scrubSpanEvent()`:

```typescript
private scrubSpanEvent(event: SpanEvent): void {
    for (const key of Object.keys(attrs)) {
        if (key.startsWith('http.request.header.') || key.startsWith('http.response.header.')) {
            const headerName = key.split('.').pop() || ''
            if (this.isSensitiveHeader(headerName)) {
                attrs[key] = REDACTED
            }
        }
    }
}
```

### 4.4 Header Sanitization Coverage Matrix

| Header | Default Scrubbed | When capture.headers=true |
|--------|-----------------|--------------------------|
| `Authorization` | ✅ (all headers stripped) | ✅ (sensitive header) |
| `Cookie` | ✅ (all headers stripped) | ✅ (sensitive header) |
| `Set-Cookie` | ✅ (all headers stripped) | ✅ (sensitive header) |
| `X-API-Key` | ✅ (all headers stripped) | ✅ (sensitive header) |
| `X-Request-ID` | ✅ (all headers stripped) | ✅ (passed through) |
| `Content-Type` | ✅ (all headers stripped) | ✅ (passed through) |
| `User-Agent` | ✅ (all headers stripped) | ✅ (passed through) |
| `X-Custom-Token` | ✅ (all headers stripped) | ⚠️ NOT scrubbed (unknown key) |

**Risk: MEDIUM.** Custom token headers (e.g., `X-My-App-Token`) are not in the sensitive header list. When `capture.headers = true`, these would be captured in spans.

---

## 5. TOKEN LEAKAGE RISKS

### 5.1 Bearer Token Leakage

**Scenario:** User passes a Bearer token in error context:

```typescript
captureError(err, {
    context: {
        authHeader: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.abc'
    }
})
```

**Processing:**
1. `isSensitiveKey('authHeader')` → `DEFAULT_SENSITIVE_KEYS_PATTERN.test('authHeader')` → matches `authorization` substring? No — `authHeader` does NOT match.
2. `sanitizeString('Bearer eyJ...')` → `Bearer\s+[A-Za-z0-9._~+/=-]+` → `Bearer [REDACTED]` ✅

**Verdict: PASS** for Bearer tokens in string values. The pattern catches `Bearer ` prefix regardless of key name.

**Risk: MEDIUM** for non-Bearer tokens (e.g., `sk-prod-abc123` without `Bearer` prefix stored under a non-standard key name).

### 5.2 API Key Leakage in URLs

**Scenario:** API key in query parameter:

```
GET /api/data?api_key=sk-prod-abc123&format=json
```

**Processing in SecurityScrubber:**
```typescript
private scrubUrlQueryString(url: string): string {
    const parsed = new URL(url, 'http://localhost')
    for (const param of this.sensitiveFields) {
        if (parsed.searchParams.has(param)) {
            parsed.searchParams.set(param, REDACTED)
        }
    }
    return changed ? parsed.toString() : url
}
```

`sensitiveFields` is populated from `config.scrubbing.fields`. If `api_key` is in the fields list, it is scrubbed. If not, it passes through.

**Default fields list:** Depends on remote config. The SDK does NOT have a hardcoded URL query parameter scrub list beyond what's in `sensitiveFields`.

**Risk: HIGH.** API keys in URL query parameters are only scrubbed if the field name is in `config.scrubbing.fields`. If the remote config does not include `api_key`, it leaks.

**Mitigation:** The `sanitizeString()` function in `ApiPayloadScrubber` applies the pattern:
```typescript
{ pattern: /(api[-_]?key|token|authorization|password|secret)=([^&\s]+)/gi, replacement: '$1=[REDACTED]' }
```

This catches `api_key=`, `api-key=`, `token=`, `authorization=`, `password=`, `secret=` in any string value.

### 5.3 JWT Token Leakage

**Scenario:** JWT in error message:

```
Error: Invalid token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.abc
```

**Processing:** The `sanitizeString()` function does NOT have a JWT-specific pattern. JWTs are only caught if they appear after `Bearer ` prefix.

**Risk: MEDIUM.** JWTs in error messages without `Bearer ` prefix are NOT automatically redacted.

**Recommendation:** Add a JWT pattern: `/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g → '[jwt]'`

### 5.4 SDK API Key Security

The SDK's own API key (`options.apiKey`) is used in:
1. HTTP POST body: `{ apiKey: "...", events: [...] }` — sent over HTTPS
2. `sendInitRequest()` body: `{ apiKey: "..." }` — sent over HTTPS
3. `MultiplexedTransport` header: `Authorization: Bearer ${this.apiKey}` — sent over HTTPS

**The API key is NEVER logged** — the SDK logs endpoint URLs but not request bodies or auth headers.

**Verdict: PASS.** API key is transmitted only over HTTPS and never logged.

### 5.5 Token Leakage Risk Matrix

| Token Type | Leakage Vector | Scrubbed | Risk |
|------------|---------------|---------|------|
| Bearer token in string | Error context/message | ✅ Pattern match | LOW |
| API key in URL query | `?api_key=...` | ✅ Pattern + SecurityScrubber | LOW |
| JWT without Bearer prefix | Error message | ❌ No pattern | MEDIUM |
| Custom token in unknown key | `{ myToken: '...' }` | ❌ Key not in list | MEDIUM |
| Session cookie in headers | `Cookie: session=...` | ✅ Header scrub | LOW |
| OAuth token in body | `{ access_token: '...' }` | ✅ Key pattern | LOW |
| Database connection string | Error context | ❌ No pattern | HIGH |
| Private key (PEM) | Error context | ❌ No pattern | HIGH |

---

---

## 6. PAYLOAD ENCRYPTION & TRANSPORT SECURITY

### 6.1 Transport Security

**File:** `src/transport/http.ts`

All SDK-to-backend communication uses HTTPS. The SDK uses Node.js's native `fetch()` API which enforces TLS certificate validation by default.

```typescript
const response = await context.with(suppressTracing(context.active()), () =>
    fetch(url, {
        method: 'POST',
        headers: { ...requestHeaders, 'x-pulse-internal': '1' },
        body: payload as BodyInit,
        signal: controller.signal,
    })
)
```

**TLS enforcement:** Node.js `fetch()` validates TLS certificates by default. There is no `rejectUnauthorized: false` or similar bypass in the SDK.

**Verdict: PASS.** All transport is over HTTPS with certificate validation.

### 6.2 Payload Encryption at Rest

**NDJSON persistence** (`src/storage/persistent-storage.ts`):

Events persisted to disk are stored as **plaintext NDJSON**. There is no encryption at rest.

```typescript
// persistent-storage.ts — flush()
await fs.appendFile(this.filePath, lines)  // ← plaintext write
```

**Risk: MEDIUM.** If the host filesystem is compromised, persisted events (including error messages, stack traces, and context data) are readable in plaintext.

**Mitigation:** The persistence directory defaults to `.tmp/pulse-sdk/events/` — a temporary directory. Events are deleted after successful transmission (`discard()`). The window of exposure is limited to the time between persistence and successful send.

**Recommendation:** Add optional AES-256-GCM encryption for persisted events using a key derived from the API key.

### 6.3 Payload Signing

**File:** `src/utils/hash.ts`

```typescript
export function hmacSha256(key: string, data: string): string {
    return createHmac('sha256', key).update(data).digest('hex')
}
```

`hmacSha256` is defined but **not used** in the transport layer. The SDK does NOT sign payloads before sending.

**Risk: LOW.** The backend authenticates requests via the `apiKey` in the request body. HMAC signing would provide additional integrity guarantees but is not currently implemented.

### 6.4 `suppressTracing` on SDK HTTP Calls

**File:** `src/transport/http.ts`

```typescript
const response = await context.with(suppressTracing(context.active()), () =>
    fetch(url, { ... })
)
```

`suppressTracing()` prevents OTel's `HttpInstrumentation` from creating spans for the SDK's own HTTP calls to the backend. This is critical for two reasons:

1. **Prevents infinite loops:** Without suppression, SDK HTTP calls would generate spans → spans would be exported → more HTTP calls → infinite loop
2. **Prevents data leakage:** SDK internal HTTP calls (containing telemetry data) would appear in the user's trace waterfall

**Verdict: PASS.** SDK self-instrumentation is correctly suppressed.

### 6.5 `x-pulse-internal` Header

```typescript
headers: {
    ...requestHeaders,
    'x-pulse-internal': '1',  // ← marks SDK-internal requests
}
```

This header allows the backend to distinguish SDK telemetry ingestion requests from user application requests. It also allows the backend to apply different rate limits or routing for SDK traffic.

---

## 7. COMPRESSION BOMB RISKS

### 7.1 Compression Bomb Definition

A compression bomb is a small compressed payload that expands to a very large size when decompressed, potentially causing OOM or DoS.

**Attack vector:** A malicious backend could respond with a compression bomb to the SDK's HTTP requests.

### 7.2 SDK as Compressor (Outbound)

The SDK compresses outbound payloads:

```typescript
// compression.ts
const MIN_COMPRESSION_BYTES = 1024

export async function compress(data: Buffer, algorithm: CompressionAlgorithm) {
    if (algorithm === 'none' || originalSize < MIN_COMPRESSION_BYTES) {
        return { buffer: data, algorithm: 'none', ... }
    }
    const buffer = await compressor(data)
    // Only use compression if it actually reduced size
    if (buffer.length >= originalSize) {
        return { buffer: data, algorithm: 'none', ... }
    }
    return { buffer, algorithm, ... }
}
```

**Outbound compression risk:** The SDK compresses its own telemetry data. The input is SDK-generated JSON — not user-controlled binary data. Compression bombs require specially crafted input (e.g., repeated patterns). SDK telemetry data is not adversarially crafted.

**Verdict: LOW RISK** for outbound compression.

### 7.3 SDK as Decompressor (Inbound)

The SDK receives responses from the backend:

```typescript
// http.ts
const text = await response.text()
const parsed = text ? tryParseJson(text) : null
```

`response.text()` uses Node.js's native `fetch()` which handles decompression automatically (via `Content-Encoding` header). There is no explicit decompression size limit.

**Risk: MEDIUM.** If the backend sends a gzip-compressed response with `Content-Encoding: gzip`, Node.js's `fetch()` will decompress it. A malicious backend could send a compression bomb.

**Mitigation:** The SDK only communicates with its own backend (configured via `apiKey` and `baseUrl`). A malicious backend would require the attacker to control the SDK's backend endpoint — which requires compromising the `apiKey` or DNS.

**Verdict: LOW RISK** in practice (requires backend compromise). **MEDIUM RISK** in adversarial environments.

### 7.4 Compression Ratio Check

```typescript
// compression.ts
if (buffer.length >= originalSize) {
    return { buffer: data, algorithm: 'none', ... }
}
```

The SDK checks that compression actually reduces size before using it. This prevents the edge case where compression increases payload size (e.g., for already-compressed or random data).

---

## 8. UNSAFE SERIALIZATION

### 8.1 `JSON.stringify` on User-Supplied Data

**File:** `src/transport/sender.ts`

```typescript
function safeJsonByteLength(value: unknown, context: Record<string, unknown>) {
    try {
        return Buffer.byteLength(JSON.stringify(value))
    } catch (error) {
        throw new SDKError('Payload is not JSON serializable', 'PAYLOAD_SERIALIZATION_FAILED', context, error)
    }
}
```

`JSON.stringify` on user-supplied data can fail for:
- **Circular references** — throws `TypeError: Converting circular structure to JSON`
- **`BigInt` values** — throws `TypeError: Do not know how to serialize a BigInt`
- **Functions** — silently omitted (not an error)
- **`undefined` values** — silently omitted (not an error)
- **`Symbol` values** — silently omitted (not an error)

**Circular reference mitigation:** `normalizeEvent()` uses `truncateObject()` with a `WeakSet` cycle guard that replaces circular references with `'[circular]'` before serialization.

**`BigInt` mitigation:** None. `BigInt` values in user context will cause serialization failure.

**Verdict: PASS** for circular references. **RISK** for `BigInt` values.

### 8.2 `JSON.parse` on Backend Responses

**File:** `src/transport/http.ts`

```typescript
function tryParseJson(text: string): unknown | undefined {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}
```

`JSON.parse` is safe — it does not execute code. The result is typed as `unknown` and must be explicitly cast before use.

**Prototype pollution via `JSON.parse`:** `JSON.parse('{"__proto__": {"polluted": true}}')` creates an object with `__proto__` as an own property, NOT as the prototype. This is safe in modern JavaScript.

**Verdict: PASS.** `JSON.parse` is used safely.

### 8.3 Worker Thread `postMessage` Serialization

**File:** `src/transport/serialization-pool.ts`

```typescript
worker.postMessage({ id, events, compression })
```

`postMessage` uses the [Structured Clone Algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm). This:
- Handles circular references (throws `DataCloneError`)
- Does NOT handle `BigInt` (throws `DataCloneError`)
- Does NOT handle functions (throws `DataCloneError`)
- Does NOT handle `Symbol` (throws `DataCloneError`)

**Risk: MEDIUM.** If user-supplied context contains `BigInt`, functions, or Symbols, `postMessage` throws `DataCloneError`. The pool catches this and falls back to main-thread serialization, which also fails for `BigInt`.

### 8.4 Prototype Pollution via `JSON.parse` + `Object.assign`

**Scenario:**
```javascript
const malicious = JSON.parse('{"__proto__": {"isAdmin": true}}')
Object.assign({}, malicious)  // ← pollutes Object.prototype
```

**SDK exposure:** The SDK uses `{ ...event }` (spread) and `Object.assign` in several places. If a user-supplied event contains `__proto__` as an own property, spread/assign could pollute `Object.prototype`.

**Mitigation in `normalizeEvent()`:**
```typescript
for (const [key, nested] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    result[key] = truncateObject(nested, ...)
}
```

**Mitigation in `SecurityScrubber`:**
```typescript
private static readonly DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

private scrubHeaders(headers): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)  // ← no prototype
    for (const [key, value] of Object.entries(headers)) {
        if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue  // ← skip dangerous keys
        result[key] = ...
    }
    return result
}
```

**Verdict: PASS** for `SecurityScrubber` output (uses `Object.create(null)`). **PARTIAL** for other spread operations — `normalizeEvent()` blocks dangerous keys but uses `{}` (with prototype) for output.

---

## 9. PROTOTYPE POLLUTION RISKS

### 9.1 Prototype Pollution Attack Surface

Prototype pollution occurs when an attacker can set `Object.prototype` properties via user-supplied data. In the SDK context, the attack surface is:

1. User-supplied `context` in `captureError()`
2. User-supplied `tags` and `extra` in `setUser()`, `setTag()`
3. HTTP request headers (from incoming requests)
4. HTTP request body (from incoming requests)
5. Remote config response (from backend)

### 9.2 Protection in `normalizeEvent()`

**File:** `src/processors/normalizer.ts`

```typescript
function truncateObject(value: unknown, maxDepth: number, currentDepth = 0, seen?: WeakSet<object>): unknown {
    // ...
    const result: Record<string, unknown> = {}  // ← standard object (has prototype)
    for (const [key, nested] of Object.entries(value)) {
        // Defense-in-depth against prototype pollution from user-supplied keys.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
        result[key] = truncateObject(nested, ...)
    }
    return result
}
```

**Verdict: PARTIAL.** Dangerous keys are blocked, but the output object `{}` has `Object.prototype`. If downstream code does `Object.assign(target, normalizedEvent)`, and `normalizedEvent` somehow contains `__proto__` (which it shouldn't after the filter), it could pollute.

### 9.3 Protection in `SecurityScrubber`

**File:** `src/processors/security-scrubber.ts`

```typescript
private scrubHeaders(headers): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)  // ← NO prototype
    for (const [key, value] of Object.entries(headers)) {
        if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue
        result[key] = ...
    }
    return result
}
```

`Object.create(null)` creates an object with NO prototype chain. Even if `__proto__` somehow survived the `DANGEROUS_KEYS` check, assigning to it would not pollute `Object.prototype`.

**Verdict: PASS** for `SecurityScrubber` output objects.

### 9.4 Protection in `scrubBodyFields()`

```typescript
private scrubBodyFields(obj, depth = 0): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null)  // ← NO prototype
    for (const [key, value] of Object.entries(obj)) {
        if (SecurityScrubber.DANGEROUS_KEYS.has(key)) continue
        // ...
    }
    return result
}
```

**Verdict: PASS.** All `SecurityScrubber` output objects use `Object.create(null)`.

### 9.5 Prototype Pollution via Remote Config

**File:** `src/core/config-manager.ts` — `deepMerge()`

```typescript
private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(source)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            if (typeof target[key] !== 'object') {
                target[key] = {}
            }
            this.deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>)
        } else {
            target[key] = value
        }
    }
}
```

**Risk: MEDIUM.** `deepMerge` does NOT check for `__proto__` keys. If the remote config response contains `{"__proto__": {"polluted": true}}`, `deepMerge` would set `target['__proto__']` — which in JavaScript sets the prototype of `target`.

**Mitigation:** `validateRemoteConfig()` validates the shape of the config before it reaches `deepMerge`. The validator checks that `features.*` and `killswitches.*` are booleans, and that required sections are plain objects. However, it does NOT explicitly block `__proto__` keys.

**Verdict: RISK.** A malicious backend could inject `__proto__` into the remote config to pollute `Object.prototype`. This requires compromising the backend or performing a MITM attack on the HTTPS connection.

**Recommendation:** Add `__proto__` key filtering to `deepMerge()`:
```typescript
if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
```

### 9.6 Prototype Pollution Risk Summary

```mermaid
flowchart TD
    A[User-supplied data] --> B{normalizeEvent\nblocks __proto__?}
    B -->|Yes| C[Dangerous keys filtered ✓]
    B -->|No — other paths| D[Risk: spread operator]

    E[HTTP headers] --> F{SecurityScrubber\nObject.create null?}
    F -->|Yes| G[No prototype chain ✓]

    H[Remote config] --> I{deepMerge\nblocks __proto__?}
    I -->|No| J[RISK: prototype pollution\nvia malicious backend]

    K[JSON.parse response] --> L{__proto__ as own property?}
    L -->|Yes| M[Safe — own property\nnot prototype chain ✓]
```

---

## 10. CONFIG INJECTION RISKS

### 10.1 Remote Config as Attack Vector

The remote config is fetched from the backend on every SDK initialization and every 300 seconds. A compromised backend or MITM attack could inject malicious config values.

**Potential injection targets:**

| Config Field | Injection Effect | Mitigation |
|-------------|-----------------|-----------|
| `transport.routes.*.url` | Redirect telemetry to attacker's server | URL validation in `RouteRegistry` |
| `sampling.traces: 0` | Disable all tracing | Legitimate config value — no mitigation |
| `killswitches.disableSDK: true` | Disable entire SDK | Legitimate config value — no mitigation |
| `limits.maxPayloadSize: 0` | Block all sends | Safety clamp: `clampMax(0, ceiling)` |
| `privacy.scrubbing.fields: []` | Disable field scrubbing | Legitimate config value — no mitigation |
| `features.errors: false` | Disable error capture | Legitimate config value — no mitigation |
| `__proto__` in config | Prototype pollution | `deepMerge` does NOT block (RISK) |

### 10.2 URL Injection in Transport Routes

**File:** `src/transport/route-registry.ts`

```typescript
function createDefinition(route: EnterpriseRoute, config: TransportRemoteConfig): RouteDefinition {
    let configured = config.routes[configRouteName]?.url
    // ...
    return {
        route,
        endpoint,
        method: 'POST',
        contentType: 'application/json',
        url: forcePath(configured, endpoint),  // ← URL from remote config
    }
}

function forcePath(rawUrl: string, endpoint: RouteDefinition['endpoint']): string {
    const url = new URL(rawUrl)  // ← validates URL format
    url.pathname = endpoint      // ← forces the path (prevents path injection)
    url.search = ''              // ← strips query params
    url.hash = ''                // ← strips fragments
    return url.toString()
}
```

**`forcePath()` security properties:**
1. `new URL(rawUrl)` — validates URL format (throws on invalid URLs)
2. `url.pathname = endpoint` — forces the path to the SDK-defined endpoint (e.g., `/v1/errors`)
3. `url.search = ''` — strips any injected query parameters
4. `url.hash = ''` — strips any injected fragments

**Risk: MEDIUM.** An attacker can change the hostname/port of the ingestion endpoint (redirect telemetry to their server) but cannot inject arbitrary paths or query parameters.

**Mitigation:** The SDK validates the URL format but does NOT validate the hostname against an allowlist. A malicious config could redirect telemetry to `https://attacker.com/v1/errors`.

**Recommendation:** Add hostname validation against the expected backend domain.

### 10.3 Config Validation as Security Boundary

**File:** `src/core/config-validator.ts`

```typescript
// transport.routes.*.url must be a non-empty string
if (typeof r['url'] !== 'string' || r['url'].length === 0) {
    errors.push(`transport.routes.${name}.url is missing or empty`)
}

// sampling.* must be [0, 1]
if (k in s && !isProbability(s[k])) {
    errors.push(`sampling.${k} is not a number in [0, 1]`)
}

// features.* must be boolean
if (typeof v !== 'boolean') {
    errors.push(`features.${k} is not a boolean`)
}
```

**What the validator catches:**
- Non-object payloads
- Missing required sections
- Wrong types for known fields
- Schema version mismatches

**What the validator does NOT catch:**
- `__proto__` injection
- Hostname injection in URLs
- Excessively large string values
- Deeply nested objects

### 10.4 Safety Clamps as Security Boundary

**File:** `src/core/config-manager.ts` — `applySafetyClamps()`

```typescript
private applySafetyClamps(config: RemoteConfigResponse): RemoteConfigResponse {
    // Prevent zero or negative limits
    clampMax(config.limits.maxPayloadSize, SAFETY_CEILINGS.maxPayloadSize)
    clampRange(config.limits.maxSpanAttributes, 1, SAFETY_CEILINGS.maxSpanAttributes)
    clampRange(config.transport.flushIntervalMs, 1000, 300_000)
    clampProbability(config.sampling.traces)
    // ...
}
```

Safety clamps prevent:
- `maxPayloadSize: 0` → would block all sends
- `flushIntervalMs: 1` → would cause 1000 HTTP requests/second
- `sampling.traces: 999` → would sample 100% (clamped to 1.0)

**Verdict: PASS.** Safety clamps prevent DoS via config manipulation.

---

## 11. CRYPTOGRAPHIC PRIMITIVES AUDIT

### 11.1 ID Generation

**File:** `src/utils/uuid.ts`

```typescript
import { randomUUID } from 'crypto'

export function generateId(): string {
    return randomUUID()  // ← crypto.randomUUID() — CSPRNG
}
```

`crypto.randomUUID()` uses the OS CSPRNG (Cryptographically Secure Pseudo-Random Number Generator). This is the correct primitive for generating IDs that must be unpredictable.

**Verdict: PASS.** All IDs use CSPRNG.

### 11.2 Hashing

**File:** `src/utils/hash.ts`

```typescript
export function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex')
}

export function sha1(input: string): string {
    return createHash('sha1').update(input).digest('hex')
}

export function hmacSha256(key: string, data: string): string {
    return createHmac('sha256', key).update(data).digest('hex')
}
```

**SHA-256** — used for error fingerprinting. Cryptographically strong. Correct for this use case.

**SHA-1** — marked `@deprecated`. Used for backward compatibility only. SHA-1 is cryptographically broken for collision resistance but acceptable for non-security-critical fingerprinting.

**HMAC-SHA256** — defined but not used in transport. Would be correct for payload signing.

**Verdict: PASS** for SHA-256. **WARN** for SHA-1 (deprecated, should be removed).

### 11.3 FNV-1a Hashing for Sampling

**File:** `src/core/sampling-engine.ts`

```typescript
static fnv1a32(input: string): number {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
}
```

FNV-1a is a **non-cryptographic** hash function. It is used for deterministic sampling decisions, NOT for security purposes.

**Security implication:** FNV-1a is NOT collision-resistant. An attacker who knows the sampling rate could craft traceIds that always hash to "sampled" or "not sampled". However, traceIds are generated by OTel using CSPRNG — they are not attacker-controlled in normal operation.

**Verdict: PASS** for the intended use case (deterministic sampling). NOT suitable for security-critical hashing.

---

## 12. DATA FLOW SECURITY MAP

### 12.1 Complete Data Flow with Security Controls

```mermaid
flowchart TD
    subgraph UserCode["User Application"]
        A[captureError / captureRequest\nUser-supplied data]
    end

    subgraph Layer1["Layer 1: Capture Gate"]
        B[evaluateCaptureGate\nKillswitch + Feature + Sampling]
        C[fallbackScrubHeaders\nBefore SecurityScrubber init]
    end

    subgraph Layer2["Layer 2: Normalizer"]
        D[truncateObject\nWeakSet cycle guard\n__proto__ blocked\nDepth limit 5]
        E[truncateString\n8192 char limit]
    end

    subgraph Layer3["Layer 3: ApiPayloadScrubber"]
        F[scrubRequestEvent\nHeader + body scrub]
        G[sanitizeString\n6 PII patterns\nemail/card/SSN/phone/Bearer/query]
        H[isSensitiveKey\npassword/secret/token/api_key/...]
    end

    subgraph Layer4["Layer 4: SecurityScrubber"]
        I[scrubHeaders\nObject.create null\nDANGEROUS_KEYS blocked]
        J[scrubBodyFields\nRemote-config fields\nDepth limit 10]
        K[scrubPiiInObject\nemail/phone/IPv4 patterns]
        L[scrubUrlQueryString\nURL.searchParams scrub]
    end

    subgraph Layer5["Layer 5: PipelineSpanExporter"]
        M[privacy.capture.headers\nStrip ALL header attrs by default]
        N[privacy.capture.body\nStrip body attrs by default]
        O[privacy.capture.cookies\nStrip cookie attrs by default]
    end

    subgraph Transport["Transport"]
        P[HTTPS POST\nTLS certificate validation\nsuppressTracing]
        Q[NDJSON persistence\nPlaintext — no encryption at rest]
    end

    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> J
    J --> K
    K --> L
    L --> M
    M --> N
    N --> O
    O --> P
    P --> Q
```

---

## 13. SECURITY FINDINGS SUMMARY

### 13.1 Critical Findings

| # | Finding | File | Severity | Fix |
|---|---------|------|---------|-----|
| S1 | `console.log` logs raw HTTP response | `transport/http.ts:88` | HIGH | Replace with `logger.debug()`, remove response object |
| S2 | `deepMerge` does not block `__proto__` | `core/config-manager.ts` | MEDIUM | Add `DANGEROUS_KEYS` check in `deepMerge()` |
| S3 | JWT tokens without `Bearer` prefix not redacted | `processors/sanitizer.ts` | MEDIUM | Add JWT pattern: `/eyJ[A-Za-z0-9_-]+\.eyJ.../g` |
| S4 | Database connection strings not redacted | `processors/sanitizer.ts` | MEDIUM | Add pattern for `postgres://`, `mongodb://`, etc. |
| S5 | PEM private keys not redacted | `processors/sanitizer.ts` | HIGH | Add pattern for `-----BEGIN PRIVATE KEY-----` |
| S6 | NDJSON persistence is plaintext | `storage/persistent-storage.ts` | MEDIUM | Add optional AES-256-GCM encryption |
| S7 | Transport URL hostname not validated | `transport/route-registry.ts` | MEDIUM | Add hostname allowlist validation |

### 13.2 Medium Findings

| # | Finding | File | Severity | Fix |
|---|---------|------|---------|-----|
| M1 | Custom token headers not scrubbed when `capture.headers=true` | `processors/sanitizer.ts` | MEDIUM | Add configurable header allowlist |
| M2 | PII deeper than depth 10 not scrubbed | `processors/sanitizer.ts` | MEDIUM | Increase depth limit or add flat scan |
| M3 | `BigInt` in context causes serialization failure | `transport/sender.ts` | MEDIUM | Add `BigInt` → `String` coercion in normalizer |
| M4 | SHA-1 still present (deprecated) | `utils/hash.ts` | LOW | Remove `sha1()` export |
| M5 | `hmacSha256` defined but not used | `utils/hash.ts` | INFO | Use for payload signing or remove |
| M6 | International phone numbers not covered | `processors/sanitizer.ts` | LOW | Add E.164 pattern |

### 13.3 Security Strengths

| Strength | Implementation | File |
|----------|---------------|------|
| CSPRNG for all IDs | `crypto.randomUUID()` | `utils/uuid.ts` |
| SHA-256 for fingerprints | `createHash('sha256')` | `utils/hash.ts` |
| TLS for all transport | Node.js `fetch()` default | `transport/http.ts` |
| `suppressTracing` on SDK calls | `suppressTracing(context.active())` | `transport/http.ts` |
| `Object.create(null)` for scrubbed output | SecurityScrubber | `processors/security-scrubber.ts` |
| `DANGEROUS_KEYS` blocking | `__proto__`, `constructor`, `prototype` | `processors/security-scrubber.ts` |
| Cycle guard in normalizer | `WeakSet` | `processors/normalizer.ts` |
| Privacy gates default OFF | `headers: false, body: false, cookies: false` | `tracing/tracer.ts` |
| Remote config validation | `validateRemoteConfig()` | `core/config-validator.ts` |
| Safety clamps on config | `applySafetyClamps()` | `core/config-manager.ts` |
| Fallback scrubbing before init | `FALLBACK_SENSITIVE_HEADER_PATTERN` | `instrumentation/request-capture-utils.ts` |
| Bearer token pattern | Hardcoded regex | `processors/sanitizer.ts` |
| Hot-swappable PII rules | `handleConfigChange()` | `processors/security-scrubber.ts` |

---

*Document generated by Kiro — Phase 7 Security & Data Safety Analysis*
*SDK: sdk-node (Pulse SDK) | Analysis Date: May 2026*
