# PII Sanitization & Security Scrubbing

## 1. Overview

Observability data must never expose sensitive customer credentials, personal identifiable information (PII), or compliance-restricted tokens.

Pulse incorporates a multi-pass security scrubber in [`src/processors/sanitizer.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/sanitizer.ts) and [`src/processors/security-scrubber.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/processors/security-scrubber.ts).

---

## 2. Scrubbing Rules & Patterns

### 2.1 Key Name Matching (Case-Insensitive)
Any object key or query parameter matching standard sensitive patterns is redacted to `"[REDACTED]"`:
- `password`, `pass`, `passwd`, `pwd`
- `secret`, `secret_key`, `client_secret`
- `token`, `access_token`, `refresh_token`, `auth_token`
- `authorization`, `proxy-authorization`
- `cookie`, `set-cookie`
- `api_key`, `apikey`, `private_key`
- `ssn`, `social_security_number`

### 2.2 Deep Value Pattern Matching (Regex)
Values undergo regex inspection regardless of their key name:
- **Credit Card Numbers:** Visa, MasterCard, Amex, Discover patterns masked via Luhn-validated regexes.
- **JSON Web Tokens (JWT):** Strings matching `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` masked to `"[JWT_REDACTED]"`.
- **Private Keys:** Blocks matching `-----BEGIN PRIVATE KEY-----` redacted.

---

## 3. Deep Recursive Object Traversal

The `SecurityScrubber` recursively traverses nested payloads up to a depth limit of 10 levels, applying both key and value sanitization across:
- HTTP request/response headers
- Request bodies (JSON)
- Error extra attributes
- Breadcrumb metadata
- Custom span attributes
- Log parameters
