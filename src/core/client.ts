import { createHash } from 'crypto'
import type { RemoteConfig, SDKInitOptions, ResolvedSDKConfig } from '../types/config.js'
import type { SDKPlugin, EventProcessor } from '../types/plugin.js'
import type { EventMetadata } from '../types/event.js'
import type { Breadcrumb } from '../types/breadcrumb.js'
import { RingBuffer } from './ring-buffer.js'
import { SDKError } from './errors.js'

const SDK_NAME = '@vikasbaplawat1/pulse-sdk'
const SDK_VERSION = '2.0.0'

class SDKClient {
  private static instance: SDKClient

  // ─── State ──────────────────────────────────────────────────────────────
  private configValue: Readonly<ResolvedSDKConfig> | null = null
  private remoteConfigValue: Readonly<RemoteConfig> | null = null
  private initPromise: Promise<Readonly<RemoteConfig> | undefined> | null = null
  private apiKeyValue: string | null = null
  private initIdentityValue: string | null = null
  private pendingInitIdentityValue: string | null = null
  private optionsValue: SDKInitOptions | null = null

  // ─── Plugin System ────────────────────────────────────────────────────
  private readonly pluginRegistry: SDKPlugin[] = []
  private readonly eventProcessorRegistry: EventProcessor[] = []

  // ─── Metadata ─────────────────────────────────────────────────────────
  private metadataValue: EventMetadata = {
    sdkName: SDK_NAME,
    sdkVersion: SDK_VERSION,
    service: 'unknown-service',
    environment: 'production',
    release: '0.0.0-unknown',
  }

  // ─── Breadcrumbs ──────────────────────────────────────────────────────
  private breadcrumbBuffer: RingBuffer<Breadcrumb> = new RingBuffer<Breadcrumb>(100)

  private constructor() {}

  static getInstance(): SDKClient {
    if (!SDKClient.instance) {
      SDKClient.instance = new SDKClient()
    }
    return SDKClient.instance
  }

  // ─── Initialization State ─────────────────────────────────────────────

  get initialized(): boolean {
    return this.configValue !== null
  }

  get config(): Readonly<ResolvedSDKConfig> {
    if (!this.configValue) {
      throw new SDKError('SDK not initialized', 'SDK_NOT_INITIALIZED')
    }
    return this.configValue
  }

  get remoteConfig(): Readonly<RemoteConfig> | null {
    return this.remoteConfigValue
  }

  get options(): Readonly<SDKInitOptions> | null {
    return this.optionsValue
  }

  get metadata(): Readonly<EventMetadata> {
    return this.metadataValue
  }

  get plugins(): readonly SDKPlugin[] {
    return this.pluginRegistry
  }

  get eventProcessors(): readonly EventProcessor[] {
    return this.eventProcessorRegistry
  }

  get breadcrumbs(): RingBuffer<Breadcrumb> {
    return this.breadcrumbBuffer
  }

  // ─── Setters ──────────────────────────────────────────────────────────

  setOptions(options: SDKInitOptions): void {
    this.optionsValue = options
    this.apiKeyValue = options.apiKey
    this.initIdentityValue = createInitIdentity(options)

    this.metadataValue = {
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      service: options.service ?? 'unknown-service',
      environment: options.environment ?? 'production',
      release: options.release ?? '0.0.0-unknown',
    }
  }

  setResolvedConfig(config: ResolvedSDKConfig): void {
    this.configValue = deepFreeze(structuredClone(config))
  }

  setRemoteConfig(config: RemoteConfig): void {
    this.remoteConfigValue = deepFreeze(structuredClone(config))
  }

  /** @deprecated Use setResolvedConfig instead */
  setConfig(config: RemoteConfig): void {
    this.setRemoteConfig(config)
  }

  clearConfig(): void {
    this.configValue = null
    this.remoteConfigValue = null
  }

  clear(): void {
    this.configValue = null
    this.remoteConfigValue = null
    this.apiKeyValue = null
    this.initIdentityValue = null
    this.pendingInitIdentityValue = null
    this.optionsValue = null
    this.initPromise = null
    this.pluginRegistry.length = 0
    this.eventProcessorRegistry.length = 0
    this.breadcrumbBuffer.clear()
  }

  // ─── API Key ──────────────────────────────────────────────────────────

  getApiKey(): string {
    if (!this.apiKeyValue) {
      throw new SDKError('SDK API key missing', 'SDK_API_KEY_MISSING')
    }
    return this.apiKeyValue
  }

  // ─── Identity Dedup ───────────────────────────────────────────────────

  hasSameIdentity(options: SDKInitOptions): boolean {
    return this.initIdentityValue === createInitIdentity(options)
  }

  setPendingIdentity(options: SDKInitOptions): void {
    this.pendingInitIdentityValue = createInitIdentity(options)
  }

  clearPendingIdentity(): void {
    this.pendingInitIdentityValue = null
  }

  hasSamePendingIdentity(options: SDKInitOptions): boolean {
    return this.pendingInitIdentityValue === createInitIdentity(options)
  }

  setInitPromise(promise: Promise<Readonly<RemoteConfig> | undefined> | null): void {
    this.initPromise = promise
  }

  getInitPromise(): Promise<Readonly<RemoteConfig> | undefined> | null {
    return this.initPromise
  }

  // ─── Plugins ──────────────────────────────────────────────────────────

  registerPlugin(plugin: SDKPlugin): void {
    const existing = this.pluginRegistry.find(p => p.meta.name === plugin.meta.name)
    if (existing) {
      throw new SDKError(
        `Plugin "${plugin.meta.name}" is already registered`,
        'DUPLICATE_PLUGIN',
        { pluginName: plugin.meta.name }
      )
    }
    this.pluginRegistry.push(plugin)
  }

  registerEventProcessor(processor: EventProcessor): void {
    this.eventProcessorRegistry.push(processor)
  }

  // ─── Breadcrumbs ──────────────────────────────────────────────────────

  initBreadcrumbs(capacity: number): void {
    this.breadcrumbBuffer = new RingBuffer<Breadcrumb>(capacity)
  }
}

export const client = SDKClient.getInstance()

function createInitIdentity(options: SDKInitOptions): string {
  return createHash('sha256').update(options.apiKey).digest('hex')
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
    Object.freeze(value)
  }
  return value as Readonly<T>
}
