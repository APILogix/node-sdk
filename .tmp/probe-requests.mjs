process.env.SDK_BASE_URL = "https://api.example.test"
process.env.LOCALAPPDATA = `${process.cwd()}\.tmp`
const { captureRequest, init, shutdown } = await import("../dist/index.js")

const calls = []
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url) })
  if (String(url).endsWith("/v1/init")) {
    return new Response(JSON.stringify({
      success: true, projectId: "p", plan: "enterprise",
      config: { samplingRate: 1, enableErrors: true, enablePerformance: true, maxRetries: 0, maxPayloadBytes: 100000 },
      ingestion: { endpoint: "https://ingest.example.test/v1/events", batchSize: 1, maxQueueSize: 100, flushInterval: 1000 },
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
}

captureRequest({ type: "request", requestId: "pre-init", url: "/pre-init", method: "GET", statusCode: 200, latency: 1, timestamp: Date.now() })
await init({ apiKey: "buffer-key" })
await shutdown()
console.log("CALLS:", JSON.stringify(calls, null, 1))
