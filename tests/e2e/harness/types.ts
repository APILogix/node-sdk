import type { IncomingHttpHeaders } from 'node:http'
import type {
  RemoteConfigResponse,
  TransportRouteName,
  FeaturesConfig,
  SamplingConfig,
  KillswitchesConfig,
  LimitsConfig,
  PrivacyConfig,
  InstrumentationConfig,
  EntitlementsConfig,
  TransportRemoteConfig,
  ConfigMeta,
  SdkIdentityConfig,
} from '../../../src/types/config.js'
import type { SDKEvent } from '../../../src/types/event.js'

export type {
  RemoteConfigResponse,
  TransportRouteName,
  FeaturesConfig,
  SamplingConfig,
  KillswitchesConfig,
  LimitsConfig,
  PrivacyConfig,
  InstrumentationConfig,
  EntitlementsConfig,
  TransportRemoteConfig,
  ConfigMeta,
  SdkIdentityConfig,
}

export type DeepPartial<T> = T extends Function
  ? T
  : T extends Array<infer U>
  ? DeepPartial<U>[]
  : T extends ReadonlyArray<infer U>
  ? readonly DeepPartial<U>[]
  : T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> | undefined }
  : T

export interface RecordedRequest {
  readonly id: string
  readonly timestamp: number
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly rawBody: Buffer
  readonly decodedBody: string
  readonly body: unknown
  readonly events: readonly SDKEvent[]
  readonly route?: TransportRouteName | 'init' | 'sdk-config' | string | undefined
  readonly statusCode: number
  readonly encoding?: string | undefined
}

export type MockRequestRecord = RecordedRequest

export type ChaosActionType =
  | 'delay'
  | 'status'
  | 'drop_connection'
  | 'malformed_json'
  | 'invalid_schema'
  | 'hang'
  | 'corrupt_gzip'
  | 'truncated_stream'

export interface ChaosRule {
  readonly id?: string | undefined
  readonly pathPattern?: string | RegExp | undefined
  readonly method?: string | undefined
  readonly route?: TransportRouteName | 'init' | 'sdk-config' | '*' | string | undefined
  readonly remainingTimes?: number | undefined
  readonly times?: number | undefined
  readonly delayMs?: number | undefined
  readonly statusCode?: number | undefined
  readonly statusHeaders?: Record<string, string> | undefined
  readonly headers?: Record<string, string> | undefined
  readonly statusBody?: unknown
  readonly responseBody?: string | object | undefined
  readonly malformedBody?: string | undefined
  readonly invalidSchemaPayload?: unknown
  readonly destroySocket?: boolean | undefined
  readonly corruptJson?: boolean | undefined
  readonly action?: ChaosActionType | undefined
}

export type FaultInjectionRule = ChaosRule

export interface MockServerOptions {
  readonly port?: number | undefined
  readonly host?: string | undefined
  readonly initialConfig?: Partial<RemoteConfigResponse> | RemoteConfigResponse | DeepPartial<RemoteConfigResponse> | undefined
  readonly projectId?: string | undefined
  readonly environment?: string | undefined
  readonly release?: string | undefined
  readonly requireApiKey?: string | undefined
  readonly autoDecompressGzip?: boolean | undefined
  readonly defaultAckChange?: boolean | undefined
  readonly debug?: boolean | undefined
}

export interface TelemetryAckPayload {
  readonly success: boolean
  readonly received: number
  readonly change: boolean
  readonly status?: number | undefined
}

export interface ProcessBaseline {
  readonly sigtermCount: number
  readonly sigintCount: number
  readonly uncaughtCount: number
  readonly unhandledCount: number
  readonly activeHandles: number
  readonly activeRequests?: number | undefined
  readonly heapUsedBytes?: number | undefined
  readonly rssBytes?: number | undefined
  readonly sigtermListeners?: number | undefined
  readonly sigintListeners?: number | undefined
  readonly uncaughtListeners?: number | undefined
  readonly unhandledListeners?: number | undefined
}

export type ProcessSnapshot = ProcessBaseline
