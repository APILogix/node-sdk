import type { SDKEvent } from '../types/event.js'
import type { TransportRemoteConfig, TransportRouteName } from '../types/config.js'

export type EnterpriseRoute = 'errors' | 'traces' | 'metrics' | 'logs' | 'profiles' | 'crons' | 'requests' | 'replays'

export interface RouteDefinition {
  readonly route: EnterpriseRoute
  readonly endpoint: '/v1/errors' | '/v1/traces' | '/v1/metrics' | '/v1/logs' | '/v1/profiles' | '/v1/checkins' | '/v1/requests' | '/v1/replays'
  readonly method: 'POST'
  readonly contentType: 'application/json'
  readonly url: string
}

export class TransportConfigurationError extends Error {
  readonly code = 'TRANSPORT_CONFIGURATION_ERROR'

  constructor(message: string, readonly context: Record<string, unknown> = {}) {
    super(message)
    this.name = 'TransportConfigurationError'
  }
}

const EVENT_TYPE_TO_ROUTE: Readonly<Record<string, EnterpriseRoute>> = Object.freeze({
  error: 'errors',
  message: 'errors',
  span: 'traces',
  trace: 'traces',
  request: 'requests',
  metric: 'metrics',
  log: 'logs',
  profile: 'profiles',
  cron_checkin: 'crons',
  replay: 'replays',
})

const ROUTE_ENDPOINTS: Readonly<Record<EnterpriseRoute, RouteDefinition['endpoint']>> = Object.freeze({
  errors: '/v1/errors',
  traces: '/v1/traces',
  metrics: '/v1/metrics',
  logs: '/v1/logs',
  profiles: '/v1/profiles',
  crons: '/v1/checkins',
  requests: '/v1/requests',
  replays: '/v1/replays',
})

export class RouteRegistry {
  private readonly definitions: Readonly<Record<EnterpriseRoute, RouteDefinition>>

  constructor(config: TransportRemoteConfig) {
    this.definitions = Object.freeze({
      errors: createDefinition('errors', config),
      traces: createDefinition('traces', config),
      metrics: createDefinition('metrics', config),
      logs: createDefinition('logs', config),
      profiles: createDefinition('profiles', config),
      crons: createDefinition('crons', config),
      requests: createDefinition('requests', config),
      replays: createDefinition('replays', config),
    })
  }

  resolve(event: SDKEvent): RouteDefinition {
    const route = EVENT_TYPE_TO_ROUTE[event.type]
    if (!route) {
      throw new TransportConfigurationError('No transport route registered for event type', {
        eventType: event.type,
      })
    }
    return this.definitions[route]
  }

  get(route: EnterpriseRoute): RouteDefinition {
    return this.definitions[route]
  }

  routes(): readonly EnterpriseRoute[] {
    return ['errors', 'traces', 'metrics', 'logs', 'profiles', 'crons', 'requests', 'replays'] as const
  }
}

function createDefinition(route: EnterpriseRoute, config: TransportRemoteConfig): RouteDefinition {
  const endpoint = ROUTE_ENDPOINTS[route]
  // Map EnterpriseRoute to TransportRouteName for config lookup
  const configRouteName = route as TransportRouteName
  // Wire schema renamed `endpoints` → `routes` in v3.
  let configured = config.routes[configRouteName]?.url

  // Fallback for missing routes in older configs
  if (!configured) {
    if (route === 'requests') {
      configured = config.routes['traces']?.url
    } else if (route === 'replays') {
      configured = config.routes['logs']?.url
    }
  }

  if (!configured) {
    throw new TransportConfigurationError('Missing endpoint for route', { route })
  }

  return {
    route,
    endpoint,
    method: 'POST',
    contentType: 'application/json',
    url: forcePath(configured, endpoint),
  }
}

function forcePath(rawUrl: string, endpoint: RouteDefinition['endpoint']): string {
  const url = new URL(rawUrl)
  url.pathname = endpoint
  url.search = ''
  url.hash = ''
  return url.toString()
}
