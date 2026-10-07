# HTTP & Network Client Instrumentation

## 1. Overview

Outbound network calls (REST APIs, microservice RPCs, third-party webhooks) must be accurately tracked and linked to parent transactions.

The Pulse SDK automatically instruments outbound HTTP/HTTPS traffic across:
- Node.js core `http` and `https` modules ([`src/instrumentation/http.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/http.ts))
- Axios HTTP client ([`src/instrumentation/axios.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/axios.ts))
- Undici (`fetch` in Node.js 18+)
- Native global `fetch`

---

## 2. Distributed Context Injection

For every outbound HTTP request initiated within an active span:
1. The SDK extracts the current `TraceId` and `SpanId` from the active context.
2. Injects standard W3C Distributed Tracing headers into the request:
   - `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
   - `tracestate: pulse=...`
   - `baggage: ...`
3. If the remote service also runs Pulse or any W3C-compatible tracer, the downstream trace is causally linked into a continuous distributed graph.

---

## 3. URL Sanitization & Credential Scrubbing

Outbound request URLs frequently contain sensitive tokens in query strings or authentication credentials:

```
Original:
https://admin:secret123@api.internal.com/v1/users?token=jwt_998877&active=true

Sanitized:
https://[REDACTED]:[REDACTED]@api.internal.com/v1/users?token=[REDACTED]&active=true
```

- **Basic Auth:** Passwords and usernames in URL authority sections are redacted.
- **Query Parameter Scrubbing:** Keys matching sensitive patterns (`token`, `auth`, `key`, `secret`, `password`) are masked before being recorded on the span.
- **Header Masking:** `Authorization`, `Proxy-Authorization`, and `Cookie` headers are stripped by default.
