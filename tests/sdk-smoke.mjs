import assert from "node:assert/strict"
import { gunzipSync } from "node:zlib"
process.env.SDK_BASE_URL = "https://api.example.test"
process.env.LOCALAPPDATA = `${process.cwd()}\\.tmp`

// The SDK gzip-compresses every batch it sends (always-on transport
// contract). Bodies captured by the fetch stubs may be binary gzip or
// plain JSON depending on the send path — detect by magic bytes.
function parseBody(body) {
  const buf = typeof body === "string"
    ? Buffer.from(body, "utf8")
    : Buffer.from(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength ?? undefined)
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
  return JSON.parse((isGzip ? gunzipSync(buf) : buf).toString("utf8"))
}

const { captureMessage, captureRequest, init, shutdown } = await import("../dist/index.js")
const { addBreadcrumb, createContextStore, withContext } = await import("../dist/core/context.js")
const { postJson } = await import("../dist/transport/http.js")
const { sendEvents, sendInitRequest } = await import("../dist/transport/sender.js")
const { redact } = await import("../dist/utils/logger.js")

function initResponse(config = {}) {
  return new Response(JSON.stringify({
    success: true,
    projectId: "test-project-id",
    plan: config.plan ?? "enterprise",
    config: {
      samplingRate: 1,
      enableErrors: true,
      enablePerformance: true,
      maxRetries: 0,
      maxPayloadBytes: 100000,
      ...config.config,
    },
    ingestion: {
      endpoint: "https://ingest.example.test/v1/events",
      batchSize: 10,
      maxQueueSize: 100,
      flushInterval: 1000,
      ...config.ingestion,
    },
  }), { status: 200, headers: { "content-type": "application/json" } })
}

function findRouteCall(calls, path) {
  return calls.find(call => {
    try {
      return new URL(call.url).pathname === path
    } catch {
      return false
    }
  })
}

{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      headers: options.headers,
      body: options.body,
    })

    if (String(url).endsWith("/v1/init")) {
      return initResponse()
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({ apiKey: "test-key" })
  await sendEvents([{ type: "manual", timestamp: Date.now() }])

  assert.equal(calls[0].url, "https://api.example.test/v1/init")
  assert.deepEqual(parseBody(calls[0].body), { apiKey: "test-key" })
  assert.equal(calls[0].headers["x-api-key"], undefined)

  assert.equal(calls[1].url, "https://ingest.example.test/v1/events")
  assert.equal(calls[1].headers["x-api-key"], undefined)
  assert.equal(parseBody(calls[1].body).apiKey, "test-key")
  assert.ok(parseBody(calls[1].body).events[0].eventId)

  await assert.rejects(
    () => init({ apiKey: "other-key" }),
    error => error.code === "SDK_ALREADY_INITIALIZED",
  )

  await shutdown()
}

{
  let pluginSetupCount = 0
  let processorCount = 0
  let beforeSendCount = 0
  let beforeBreadcrumbCount = 0
  const calls = []

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body })

    if (String(url).endsWith("/v1/init")) {
      return initResponse({ ingestion: { batchSize: 1 } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({
    apiKey: "hooks-key",
    plugins: [{
      meta: { name: "test-plugin", version: "1.0.0" },
      setup() {
        pluginSetupCount += 1
      },
      processEvent(event) {
        return { ...event, pluginProcessed: true }
      },
      processBreadcrumb(breadcrumb) {
        return { ...breadcrumb, data: { ...(breadcrumb.data ?? {}), pluginBreadcrumb: true } }
      },
    }],
    eventProcessors: [
      event => {
        processorCount += 1
        return { ...event, processorProcessed: true }
      },
    ],
    beforeBreadcrumb: breadcrumb => {
      beforeBreadcrumbCount += 1
      return { ...breadcrumb, data: { ...(breadcrumb.data ?? {}), beforeBreadcrumb: true } }
    },
    beforeSend: event => {
      beforeSendCount += 1
      return { ...event, beforeSendProcessed: true }
    },
  })

  withContext(createContextStore("hook-request", 10), () => {
    addBreadcrumb({ category: "test", message: "hook crumb" })
    captureMessage("hook message")
  })
  await shutdown()

  const errorCall = findRouteCall(calls, "/v1/errors")
  const event = parseBody(errorCall.body).events[0]

  assert.equal(pluginSetupCount, 1)
  assert.equal(processorCount, 1)
  assert.equal(beforeSendCount, 1)
  assert.equal(beforeBreadcrumbCount, 1)
  assert.equal(event.pluginProcessed, true)
  assert.equal(event.processorProcessed, true)
  assert.equal(event.beforeSendProcessed, true)
  assert.equal(event.breadcrumbs[0].data.beforeBreadcrumb, true)
  assert.equal(event.breadcrumbs[0].data.pluginBreadcrumb, true)
}

{
  let beforeSendCount = 0
  const calls = []

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body })

    if (String(url).endsWith("/v1/init")) {
      return initResponse({ plan: "free", ingestion: { batchSize: 1 } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({
    apiKey: "free-before-send-key",
    beforeSend: event => {
      beforeSendCount += 1
      return { ...event, shouldNotAppear: true }
    },
  })

  captureMessage("free hook message")
  await shutdown()

  const errorCall = findRouteCall(calls, "/v1/errors")
  const event = parseBody(errorCall.body).events[0]

  // v3 contract: beforeSend is available on every plan — it is no longer
  // gated behind a paid tier.
  assert.equal(beforeSendCount, 1)
  assert.equal(event.shouldNotAppear, true)
}

{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body })
    return initResponse()
  }

  await sendInitRequest("direct-key", "https://api.example.test/", 1000)
  assert.equal(calls[0].url, "https://api.example.test/v1/init")
  assert.deepEqual(parseBody(calls[0].body), { apiKey: "direct-key" })

  await assert.rejects(
    () => sendInitRequest("", "https://api.example.test", 1000),
    error => error.code === "INVALID_API_KEY",
  )
}

{
  let resolveInit
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/init")) {
      await new Promise(resolve => {
        resolveInit = resolve
      })
      return initResponse()
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const pending = init({ apiKey: "pending-key" })
  await assert.rejects(
    () => init({ apiKey: "different-pending-key" }),
    error => error.code === "SDK_INIT_IN_PROGRESS",
  )
  resolveInit()
  await pending
  await shutdown()
}

{
  globalThis.fetch = async () => initResponse({ ingestion: { maxQueueSize: undefined } })

  assert.equal(await init({ apiKey: "bad-config-key" }), undefined)
  await shutdown()
}

{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body })

    if (String(url).endsWith("/v1/init")) {
      return initResponse({ config: { maxPayloadBytes: 110 } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({ apiKey: "split-key" })
  await sendEvents([{ type: "x" }, { type: "x" }, { type: "x" }])

  const ingestCalls = calls.filter(call => call.url === "https://ingest.example.test/v1/events")
  assert.equal(ingestCalls.length, 3)

  await shutdown()
}

{
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/init")) return initResponse()
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({ apiKey: "invalid-event-key" })

  await assert.rejects(
    () => sendEvents([{ type: "manual", eventId: "" }]),
    error => error.code === "INVALID_EVENT_ID",
  )

  const circular = { type: "manual" }
  circular.self = circular

  await assert.rejects(
    () => sendEvents([circular]),
    error => error.code === "PAYLOAD_SERIALIZATION_FAILED",
  )

  await shutdown()
}

{
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/v1/init")) return initResponse({ config: { maxPayloadBytes: 0 } })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  assert.equal(await init({ apiKey: "invalid-payload-config" }), undefined)
  await shutdown()
}

{
  let ingestAttempts = 0
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/v1/init")) {
      return initResponse({ config: { maxPayloadBytes: 110 } })
    }

    ingestAttempts += 1
    if (ingestAttempts === 2) {
      return new Response(JSON.stringify({ failed: true }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({ apiKey: "partial-key" })

  await assert.rejects(
    () => sendEvents([{ type: "x" }, { type: "x" }, { type: "x" }]),
    error =>
      error.code === "INGEST_SEND_FAILED" &&
      error.context.sentPayloads === 1 &&
      error.context.totalEventCount === 3,
  )

  await shutdown()
}

{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body })

    if (String(url).endsWith("/v1/init")) {
      return initResponse({ ingestion: { batchSize: 1 } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  captureRequest({
    type: "request",
    requestId: "pre-init",
    url: "/pre-init",
    method: "GET",
    statusCode: 200,
    latency: 1,
    timestamp: Date.now(),
  })
  await init({ apiKey: "buffer-key" })
  await shutdown()

  // v3 routes request events to the dedicated /v1/requests ingest route.
  const traceCall = findRouteCall(calls, "/v1/requests")
  assert.ok(traceCall)
  assert.equal(parseBody(traceCall.body).events[0].requestId, "pre-init")
}

{
  globalThis.fetch = async () => new Response("<html>bad</html>", { status: 500 })

  await assert.rejects(
    () => postJson("https://api.example.test/fail", {}, {}, 1000),
    error => error.code === "HTTP_ERROR" && error.context.status === 500,
  )
}

{
  const redacted = redact("authorization=Bearer abc apiKey=secret token=secret2")
  assert.equal(redacted.includes("secret"), false)
  assert.equal(redacted.includes("abc"), false)
}
