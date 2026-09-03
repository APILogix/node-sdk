import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChaosRule, FaultInjectionRule, TransportRouteName } from './types.js'

export class ChaosEngine {
  private rules: ChaosRule[] = []

  addRule(rule: ChaosRule): string {
    const id = rule.id ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const normalizedTimes = rule.remainingTimes ?? rule.times ?? 1
    this.rules.push({
      ...rule,
      id,
      remainingTimes: normalizedTimes,
      times: normalizedTimes,
    })
    return id
  }

  injectFault(rule: FaultInjectionRule): string {
    return this.addRule(rule)
  }

  clear(): void {
    this.rules = []
  }

  clearFaults(): void {
    this.clear()
  }

  removeRule(id: string): boolean {
    const idx = this.rules.findIndex(r => r.id === id)
    if (idx >= 0) {
      this.rules.splice(idx, 1)
      return true
    }
    return false
  }

  getRules(): readonly ChaosRule[] {
    return [...this.rules]
  }

  injectLatency(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    delayMs: number,
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'delay',
      delayMs,
      times,
    })
  }

  injectStatus(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    statusCode: number,
    headers: Record<string, string> = {},
    body: unknown = { error: 'chaos error', statusCode },
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'status',
      statusCode,
      statusHeaders: headers,
      statusBody: body,
      times,
    })
  }

  injectRateLimit(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string = '*',
    retryAfterSeconds = 2,
    times = 1,
  ): string {
    return this.injectStatus(
      routeOrPattern,
      429,
      { 'Retry-After': String(retryAfterSeconds), 'X-RateLimit-Remaining': '0' },
      { error: 'rate limited', retryAfter: retryAfterSeconds },
      times,
    )
  }

  injectNetworkDrop(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'drop_connection',
      destroySocket: true,
      times,
    })
  }

  injectMalformedJson(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    malformedBody = '{"corrupted_json": true, unclosed_string: "',
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'malformed_json',
      corruptJson: true,
      malformedBody,
      times,
    })
  }

  injectInvalidSchema(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    invalidPayload: unknown = { schemaVersion: 99, invalidField: true },
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'invalid_schema',
      invalidSchemaPayload: invalidPayload,
      times,
    })
  }

  injectCorruptGzip(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'corrupt_gzip',
      times,
    })
  }

  injectTruncatedStream(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'truncated_stream',
      times,
    })
  }

  injectHang(
    routeOrPattern: TransportRouteName | 'init' | 'sdk-config' | '*' | string | RegExp,
    times = 1,
  ): string {
    return this.addRule({
      route: typeof routeOrPattern === 'string' && !routeOrPattern.includes('/') ? (routeOrPattern as any) : undefined,
      pathPattern: typeof routeOrPattern === 'object' || (typeof routeOrPattern === 'string' && routeOrPattern.includes('/')) ? routeOrPattern : undefined,
      action: 'hang',
      times,
    })
  }

  async evaluate(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
    path: string,
  ): Promise<{ handled: boolean }> {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i]!
      if (!this.matches(rule, req, route, path)) continue

      const remaining = (rule.remainingTimes ?? 1) - 1
      if (remaining <= 0) {
        this.rules.splice(i, 1)
        i--
      } else {
        (rule as { remainingTimes: number }).remainingTimes = remaining
      }

      if (rule.delayMs && rule.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, rule.delayMs))
      }

      if (rule.action === 'drop_connection' || rule.destroySocket) {
        try {
          req.socket?.destroy()
        } catch {}
        return { handled: true }
      }

      if (rule.action === 'status' || (rule.statusCode && rule.statusCode >= 300)) {
        const headers = rule.statusHeaders ?? rule.headers ?? {}
        const body = rule.statusBody ?? rule.responseBody ?? { error: 'chaos status', statusCode: rule.statusCode ?? 500 }
        res.writeHead(rule.statusCode ?? 500, {
          'content-type': 'application/json',
          ...headers,
        })
        res.end(typeof body === 'string' ? body : JSON.stringify(body))
        return { handled: true }
      }

      if (rule.action === 'malformed_json' || rule.corruptJson) {
        res.writeHead(rule.statusCode ?? 200, {
          'content-type': 'application/json',
          ...(rule.statusHeaders ?? rule.headers ?? {}),
        })
        res.end(rule.malformedBody ?? '{"invalid_json": true, broken:')
        return { handled: true }
      }

      if (rule.action === 'invalid_schema') {
        const payload = rule.invalidSchemaPayload ?? { schemaVersion: 99 }
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(rule.statusHeaders ?? rule.headers ?? {}),
        })
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
        return { handled: true }
      }

      if (rule.action === 'corrupt_gzip') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          ...(rule.statusHeaders ?? rule.headers ?? {}),
        })
        res.end(Buffer.from([0x1f, 0x8b, 0x00, 0x99, 0xff, 0xee, 0xdd, 0xcc]))
        return { handled: true }
      }

      if (rule.action === 'truncated_stream') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        })
        res.write('{"partial": "data')
        try {
          req.socket?.destroy()
        } catch {}
        return { handled: true }
      }

      if (rule.action === 'hang') {
        // Deliberately do not send response, socket stays idle
        return { handled: true }
      }

      if (rule.action === 'delay') {
        // Delay only, continue normal handling
        return { handled: false }
      }
    }

    return { handled: false }
  }

  private matches(rule: ChaosRule, req: IncomingMessage, route: string, path: string): boolean {
    if (rule.method && req.method?.toUpperCase() !== rule.method.toUpperCase()) {
      return false
    }

    if (rule.route && rule.route !== '*') {
      if (rule.route !== route && !path.includes(rule.route)) {
        return false
      }
    }

    if (rule.pathPattern) {
      if (typeof rule.pathPattern === 'string') {
        if (!path.includes(rule.pathPattern) && !req.url?.includes(rule.pathPattern)) {
          return false
        }
      } else if (rule.pathPattern instanceof RegExp) {
        if (!rule.pathPattern.test(path) && !rule.pathPattern.test(req.url ?? '')) {
          return false
        }
      }
    }

    return true
  }
}
