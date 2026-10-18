import type { SDKEvent } from '../types/event.js'
import type { TransportRemoteConfig } from '../types/config.js'

export type EnterpriseRoute = 'errors' | 'events' | 'traces' | 'spans' | 'metrics' | 'logs' | 'profiles' | 'crons' | 'requests'

export interface RouteDefinition {
  readonly route: EnterpriseRoute
  readonly method: 'POST'
  readonly contentType: 'application/json'
  /** Exact validated URL supplied by the active remote snapshot. */
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
  message: 'events',
  span: 'spans',
  trace: 'traces',
  request: 'requests',
  metric: 'metrics',
  log: 'logs',
  profile: 'profiles',
  cron_checkin: 'crons',
})

export class RouteRegistry {
  private readonly definitions: Readonly<Record<EnterpriseRoute, RouteDefinition>>

  constructor(config: TransportRemoteConfig) {
    this.definitions = Object.freeze({
      errors: createDefinition('errors', config),
      events: createDefinition('events', config),
      traces: createDefinition('traces', config),
      spans: createDefinition('spans', config),
      metrics: createDefinition('metrics', config),
      logs: createDefinition('logs', config),
      profiles: createDefinition('profiles', config),
      crons: createDefinition('crons', config),
      requests: createDefinition('requests', config),
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

  getRoutes(): readonly EnterpriseRoute[] {
    return this.routes()
  }

  routes(): readonly EnterpriseRoute[] {
    return ['errors', 'events', 'traces', 'spans', 'metrics', 'logs', 'profiles', 'crons', 'requests'] as const
  }
}

function createDefinition(route: EnterpriseRoute, config: TransportRemoteConfig): RouteDefinition {
  return {
    route,
    method: 'POST',
    contentType: 'application/json',
    url: config.routes[route].url,
  }
}
