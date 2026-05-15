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

we want that is our sdk should not crash the user backend so intead of thoruwing erro logg there the issue .second also  implemt the retry logic for init funtion if aielf tretur logic of 5 time and on each retry log .and also update our logger.ts file to 
You are a senior staff engineer tasked with upgrading the entire SDK logging system to enterprise-grade structured logging.

## OBJECTIVE

Refactor all existing logging to follow a consistent, structured, production-ready logging standard.

## REQUIRED LOGGING STANDARD

Every log must:

* Be structured (JSON object, not string concatenation)
* Use the centralized logger (`getLogger()`)
* Include:

  * `message` (human readable)
  * `event` (machine readable constant)
  * relevant metadata (attempt, userId, requestId, etc.)
* NEVER include sensitive data (tokens, api keys, passwords)

## STRICT RULES

1. ❌ Remove all:

   * console.log / console.warn / console.error
   * string prefixes like "[SDK]"
   * unstructured logs

2. ✅ Replace with:
   logger.<level>(message, {
   event: "EVENT_NAME",
   ...context
   })

3. Event naming convention:

   * UPPER_SNAKE_CASE
   * Examples:

     * SDK_INIT_STARTED
     * SDK_INIT_RETRY
     * SDK_INIT_FAILED
     * API_REQUEST_SENT
     * API_RESPONSE_RECEIVED
     * INGESTION_FAILED

4. Log levels:

   * debug → internal details
   * info → normal operations
   * warn → retry / recoverable issues
   * error → failures

5. Retry logging rules:

   * DO NOT log every retry blindly
   * Log:

     * first attempt
     * last failure
     * important transitions only

6. Errors:

   * Always log structured error object
   * Never stringify errors manually

7. Context:

   * Always include useful metadata:

     * requestId / correlationId
     * attempt count
     * endpoint
     * statusCode

## OUTPUT FORMAT

Before:
console.log("[SDK] failed", error)

After:
logger.error("SDK request failed", {
event: "API_REQUEST_FAILED",
error,
endpoint,
})

## ADDITIONAL IMPROVEMENTS

* Add missing logs where critical flows lack visibility
* Ensure consistency across all modules
* Remove duplicate or noisy logs

## GOAL

Make logs:

* Queryable
* Consistent
* Safe
* Useful in production observability systems (Datadog, ELK, etc.)

Refactor the entire codebase accordingly.
