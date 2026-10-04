# API Keys & Secret Isolation

## 1. Authentication Protocol

All communications between the Pulse SDK and the control plane / ingestion backend require authentication using a Pulse APM Project API Key.

The API key is passed in the HTTP request headers:
```http
x-pulse-api-key: pls_live_9a8b7c6d5e4f3a2b1
```

---

## 2. In-Memory Secret Isolation

Because the SDK is an observability tool capturing application memory and error objects, it must protect its own API key from accidental exposure:

1. **Excluded from Diagnostic Exports:** The API key is masked in `client.getSanitizedConfig()`.
2. **Excluded from Error Scopes:** If an error occurs inside the SDK, internal stack frames and error attributes strip the API key value.
3. **Excluded from Logs:** Console debug logs redact the API key, displaying only the first 8 characters (e.g., `pls_live_****`).

---

## 3. Invalid API Key Handling (HTTP 401)

If the control plane or ingestion endpoint returns an HTTP 401 (Unauthorized) status code:
- The SDK treats this as a **permanent fatal configuration error**.
- The `BackgroundRecoveryWorker` terminates immediately and does not retry.
- Transport routes are deactivated.
- An error log is printed once to `console.error` alerting the developer to check their credentials.
- The host application continues running without disruption.
