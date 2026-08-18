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

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition")
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const { captureMessage, captureRequest, init, shutdown } = await import("../dist/index.js")
const { DEFAULT_API_BASE_URL } = await import("../dist/constants/defaults.js")
const { BAKED_IN_REMOTE_CONFIG } = await import("../dist/constants/defaults.js")
const { addBreadcrumb, createContextStore, withContext } = await import("../dist/core/context.js")
const { postJson } = await import("../dist/transport/http.js")
const { sendEvents, sendInitRequest } = await import("../dist/transport/sender.js")
const { redact } = await import("../dist/utils/logger.js")

function schemaConfig(config = {}) {
  if (config.rawConfig) return config.rawConfig

  const routePath = {
    errors: "/api/v1/errors",
    events: "/api/v1/events",
    traces: "/api/v1/traces",
    spans: "/api/v1/spans",
    requests: "/api/v1/requests",
    metrics: "/api/v1/metrics",
    logs: "/api/v1/logs",
    profiles: "/api/v1/profiles",
    crons: "/api/v1/checkins",
    replays: "/api/v1/replays",
  }
  const batchSize = config.ingestion?.batchSize ?? 10
  const flushIntervalMs = config.ingestion?.flushInterval ?? 1000
  const maxPayloadSize = config.config?.maxPayloadBytes ?? 100000
  const routes = Object.fromEntries(
    Object.entries(BAKED_IN_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
      name,
      {
        ...route,
        url: `https://ingest.example.test${routePath[name]}`,
        batchSize,
        flushIntervalMs,
        timeoutMs: 5000,
      },
    ]),
  )

  return {
    ...BAKED_IN_REMOTE_CONFIG,
    sdk: { projectId: "test-project-id", environment: "test" },
    features: { ...BAKED_IN_REMOTE_CONFIG.features, errors: true, requestCapture: true, tracing: true },
    sampling: { ...BAKED_IN_REMOTE_CONFIG.sampling, requests: 1, traces: 1, errors: 1 },
    killswitches: { ...BAKED_IN_REMOTE_CONFIG.killswitches, disableTransport: false },
    limits: {
      ...BAKED_IN_REMOTE_CONFIG.limits,
      maxPayloadSize,
      maxQueueSize: config.ingestion?.maxQueueSize ?? 10000,
    },
    transport: {
      ...BAKED_IN_REMOTE_CONFIG.transport,
      queue: {
        ...BAKED_IN_REMOTE_CONFIG.transport.queue,
        maxSize: config.ingestion?.maxQueueSize ?? 10000,
      },
      retry: { ...BAKED_IN_REMOTE_CONFIG.transport.retry, maxRetries: config.config?.maxRetries ?? 0 },
      routes,
    },
    meta: { generatedAt: new Date().toISOString(), generatedBy: "sdk-smoke" },
  }
}

function initResponse(config = {}) {
  return new Response(JSON.stringify({
    success: true,
    projectId: "test-project-id",
    environment: "test",
    config: schemaConfig(config),
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

    if (String(url).endsWith("/api/v1/init")) {
      return initResponse()
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({ apiKey: "test-key" })
  await sendEvents([{ type: "manual", timestamp: Date.now() }])

  const initCall = findRouteCall(calls, "/api/v1/init")
  assert.equal(initCall.url, "https://api.example.test/api/v1/init")
  assert.deepEqual(parseBody(initCall.body), {})
  assert.equal(initCall.headers.Authorization, "Bearer test-key")
  assert.equal(initCall.headers["x-api-key"], undefined)

  const ingestCall = findRouteCall(calls, "/api/v1/events")
  assert.equal(ingestCall.url, "https://ingest.example.test/api/v1/events")
  assert.equal(ingestCall.headers.Authorization, "Bearer test-key")
  assert.equal(ingestCall.headers["x-api-key"], undefined)
  assert.equal(parseBody(ingestCall.body).apiKey, undefined)
  assert.ok(parseBody(ingestCall.body).events[0].eventId)

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

    if (String(url).endsWith("/api/v1/init")) {
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

  const eventCall = findRouteCall(calls, "/api/v1/events")
  const event = parseBody(eventCall.body).events[0]

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

    if (String(url).endsWith("/api/v1/init")) {
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

  const eventCall = findRouteCall(calls, "/api/v1/events")
  const event = parseBody(eventCall.body).events[0]

  // v3 contract: beforeSend is available on every plan — it is no longer
  // gated behind a paid tier.
  assert.equal(beforeSendCount, 1)
  assert.equal(event.shouldNotAppear, true)
}

{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body, headers: options.headers })
    return initResponse()
  }

  await sendInitRequest("direct-key", "https://api.example.test/", 1000)
  assert.equal(calls[0].url, "https://api.example.test/api/v1/init")
  assert.deepEqual(parseBody(calls[0].body), {})
  assert.equal(calls[0].headers.Authorization, "Bearer direct-key")

  delete process.env.SDK_BASE_URL
  await sendInitRequest("default-key", undefined, 1000)
  assert.equal(calls[1].url, `${DEFAULT_API_BASE_URL}/api/v1/init`)
  process.env.SDK_BASE_URL = "https://api.example.test"

  await assert.rejects(
    () => sendInitRequest("", "https://api.example.test", 1000),
    error => error.code === "INVALID_API_KEY",
  )
}

{
  let resolveInit
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/v1/init")) {
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
  await waitFor(() => typeof resolveInit === "function")
  await assert.rejects(
    () => init({ apiKey: "different-pending-key" }),
    error => error.code === "SDK_INIT_IN_PROGRESS",
  )
  resolveInit()
  await pending
  await shutdown()
}

{
  globalThis.fetch = async () => initResponse({ rawConfig: {} })

  assert.equal(await init({ apiKey: "bad-config-key" }), undefined)
  await shutdown()
}

{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body })

    if (String(url).endsWith("/api/v1/init")) {
      return initResponse({ config: { maxPayloadBytes: 110 } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await init({ apiKey: "split-key" })
  await sendEvents([{ type: "x" }, { type: "x" }, { type: "x" }])

  const ingestCalls = calls.filter(call => call.url === "https://ingest.example.test/api/v1/events")
  assert.equal(ingestCalls.length, 3)

  await shutdown()
}

{
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/v1/init")) return initResponse()
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
    if (String(url).endsWith("/api/v1/init")) return initResponse({ rawConfig: {} })
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
    if (String(url).endsWith("/api/v1/init")) {
      return initResponse({ config: { maxPayloadBytes: 110 } })
    }

    if (String(url).endsWith("/api/v1/events")) {
      ingestAttempts += 1
      if (ingestAttempts === 2) {
        return new Response(JSON.stringify({ failed: true }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      }
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

    if (String(url).endsWith("/api/v1/init")) {
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

  // v3 routes request events to the dedicated /api/v1/requests ingest route.
  const traceCall = findRouteCall(calls, "/api/v1/requests")
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
