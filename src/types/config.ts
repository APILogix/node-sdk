export interface SDKInitOptions {
  apiKey: string
}

export interface RemoteConfig {
  ingestUrl: string
  samplingRate: number
  enableErrors: boolean
  enablePerformance: boolean
  maxQueueSize: number
  batchSize: number
  flushIntervalMs: number
  maxRetries: number
  maxPayloadBytes: number
}
