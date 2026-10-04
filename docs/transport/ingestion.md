# Ingestion Endpoints & Payload Formats

## 1. HTTP Ingestion Protocol

All telemetry transmitted by `@pulse-apm/node` is sent via HTTP POST to the configured ingestion endpoint (e.g., `https://ingest.pulse.io` or customer-specified `PULSE_ENDPOINT`).

---

## 2. Ingestion Request Headers

Every outbound telemetry dispatch includes standardized identification and compression headers:

```http
POST /v1/errors HTTP/1.1
Host: ingest.pulse.io
x-pulse-api-key: pls_live_9a8b7c6d5e4f3a2b1
x-pulse-sdk-version: 8.4.5
x-pulse-sdk-name: @pulse-apm/node
x-pulse-sent-at: 1727954400000
Content-Type: application/json; charset=utf-8
Content-Encoding: gzip
User-Agent: PulseNodeSDK/8.4.5 (Node.js v20.11.0; win32 x64)
Connection: keep-alive
```

---

## 3. Batch Envelope Schema

Telemetry records are bundled inside a standard batch envelope:

```json
{
  "projectId": "proj_prod_991823",
  "environment": "production",
  "release": "1.0.4",
  "sentAt": "2026-10-03T11:42:00.000Z",
  "batchId": "b1a2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "events": [
    {
      "eventId": "...",
      "timestamp": "...",
      "type": "error",
      ...
    }
  ]
}
```

---

## 4. Response Codes & Processing

| Status Code | Meaning | SDK Client Action |
|---|---|---|
| **`200 OK` / `202 Accepted`** | Batch ingested successfully. | Evict batch from buffer; reset route failure counters. |
| **`400 Bad Request`** | Schema validation failed on backend. | Discard batch; log warning once. Do not retry malformed data. |
| **`401 Unauthorized`** | Invalid or expired API Key. | Stop transport permanently; log authentication failure. |
| **`429 Too Many Requests`** | Tenant ingestion quota exceeded. | Extract `Retry-After`; pause route dispatches. |
| **`500 / 502 / 503 / 504`** | Backend temporary outage. | Route circuit breaker increments; batch retried up to limit. |
