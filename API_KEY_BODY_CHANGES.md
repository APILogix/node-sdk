# API Key Body Payload Changes

## Summary

- `init({ apiKey })` stores the API key in the SDK client global state.
- The init request already sends `{ "apiKey": "<key>" }` in the request body.
- Event ingestion requests now also send the stored API key in the JSON body.
- The SDK no longer sends the API key through the `x-api-key` header for ingestion.

## Ingestion Payload Shape

```json
{
  "apiKey": "pk_example",
  "events": []
}
```

Every event batch sent after `init()` uses the API key that was passed to `init()`.
