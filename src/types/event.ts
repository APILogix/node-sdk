// types/event.ts
export interface RequestEvent {
  type: "request"
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