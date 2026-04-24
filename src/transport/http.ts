import { SDKError, toError } from "../core/errors.js"

export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    console.log("[sdk response of ingest",response)

    const text = await response.text()
    const parsed = text ? tryParseJson(text) : null

    if (!response.ok) {
      throw new SDKError("HTTP request failed", "HTTP_ERROR", {
        url,
        status: response.status,
        body: previewBody(parsed ?? text),
      })
    }

    if (text && parsed === undefined) {
      throw new SDKError("Invalid JSON response", "INVALID_JSON", {
        url,
        status: response.status,
        bodyPreview: text.slice(0, 500),
      })
    }

    return parsed as T
  } catch (error) {
    if (error instanceof SDKError) {
      throw error
    }

    const normalized = toError(error)
    throw new SDKError("Network request failed", "NETWORK_ERROR", {
      url,
      reason: normalized.name === "AbortError" ? "timeout" : normalized.message,
    }, normalized)
  } finally {
    clearTimeout(timeout)
  }
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function previewBody(body: unknown) {
  if (typeof body === "string") return body.slice(0, 500)
  return body
}
