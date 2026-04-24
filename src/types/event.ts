// types/event.ts
export interface RequestEvent {
  type: "request"
  eventId?: string
  requestId: string
  url: string
  method: string
  statusCode: number
  latency: number
  timestamp: number

  headers?: Record<string, any>
  query?: Record<string, any>
  bodySize?: number

  userId?: string | null
}

export interface ErrorEvent {
  type: "error"
  eventId?: string
  requestId?: string
  message: string
  name: string
  stack: unknown[]
  fingerprint: string
  timestamp: number
  context: Record<string, unknown>
}

export type Event = RequestEvent | ErrorEvent | (Record<string, unknown> & { eventId?: string })
