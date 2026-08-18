import { createHash } from 'node:crypto'
import type { RemoteConfigResponse, SDKInitOptions } from '../types/config.js'
import type { SDKPlugin, EventProcessor } from '../types/plugin.js'
import type { EventMetadata } from '../types/event.js'
import type { Breadcrumb } from '../types/breadcrumb.js'
import type { InitResponse } from './remote-config-client.js'
import { RingBuffer } from './ring-buffer.js'
import { SDKError } from './errors.js'
import { ConfigManager } from './config-manager.js'
import { SDK_NAME, SDK_VERSION } from '../constants/version.js'
import { resolveApplicationPackage } from '../utils/package-metadata.js'

class SDKClient {
  private static instance: SDKClient

  private initializedValue = false
  private initMetadataValue: Omit<InitResponse, 'config'> | null = null
  private initPromise: Promise<Readonly<RemoteConfigResponse> | undefined> | null = null
  private apiKeyValue: string | null = null
  private initIdentityValue: string | null = null
  private pendingInitIdentityValue: string | null = null
  private optionsValue: SDKInitOptions | null = null

  private readonly pluginRegistry: SDKPlugin[] = []
  private readonly eventProcessorRegistry: EventProcessor[] = []

  private metadataValue: EventMetadata = Object.freeze({
    sdkName: SDK_NAME,
    sdkVersion: SDK_VERSION,
    applicationName: 'unknown-application',
    applicationVersion: '0.0.0-unknown',
    // Bootstrap-only placeholder. The authoritative value is applied by
    // `applyRemoteIdentity()` from `config.sdk.projectId` before the SDK
    // is marked initialized — no event can transport with this placeholder.
    projectId: 'unknown-project',
    environment: 'production',
    release: '0.0.0-unknown',
  })

  private breadcrumbBuffer: RingBuffer<Breadcrumb> = new RingBuffer<Breadcrumb>(100)

  private constructor() {}

  static getInstance(): SDKClient {
    if (!SDKClient.instance) SDKClient.instance = new SDKClient()
    return SDKClient.instance
  }

  get initialized(): boolean {
    return this.initializedValue && ConfigManager.getCurrent()?.isLive() === true
  }

  get remoteConfig(): Readonly<RemoteConfigResponse> | null {
    return ConfigManager.getCurrent()?.getConfigOrNull() ?? null
  }

  get initResponse(): Readonly<InitResponse> | null {
    const config = this.remoteConfig
    if (!this.initMetadataValue || !config) return null
    return Object.freeze({ ...this.initMetadataValue, config })
  }

  get projectId(): string | null {
    return this.remoteConfig?.sdk.projectId ?? null
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

  setOptions(options: SDKInitOptions): void {
    this.optionsValue = options
    this.apiKeyValue = options.apiKey
    this.initIdentityValue = createInitIdentity(options)

    const applicationPackage = resolveApplicationPackage(options)
    this.metadataValue = Object.freeze({
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      applicationName: applicationPackage.name,
      applicationVersion: applicationPackage.version,
      // Bootstrap-only. The validated backend identity (including
      // projectId) is applied via applyRemoteIdentity() before the SDK is
      // marked initialized.
      projectId: this.metadataValue.projectId,
      environment: 'production',
      release: applicationPackage.version,
    })
  }

  /**
   * Apply the authoritative identity fields from the active remote
   * configuration snapshot. `projectId` always comes exclusively from
   * `config.sdk.projectId` — never from init options, local config,
   * package.json, environment variables, or any other fallback.
   */
  applyRemoteIdentity(config: Readonly<RemoteConfigResponse>): void {
    this.metadataValue = Object.freeze({
      ...this.metadataValue,
      projectId: config.sdk.projectId,
      environment: config.sdk.environment,
      release: config.sdk.release,
    })
  }

  markInitialized(): void {
    this.initializedValue = true
  }

  setInitResponse(response: InitResponse): void {
    const { config: _config, ...metadata } = response
    this.initMetadataValue = deepFreeze(structuredClone(metadata))
  }

  clearConfig(): void {
    this.initializedValue = false
    this.initMetadataValue = null
  }

  clear(): void {
    this.initializedValue = false
    this.initMetadataValue = null
    this.apiKeyValue = null
    this.initIdentityValue = null
    this.pendingInitIdentityValue = null
    this.optionsValue = null
    this.initPromise = null
    this.pluginRegistry.length = 0
    this.eventProcessorRegistry.length = 0
    this.breadcrumbBuffer.clear()
  }

  getApiKey(): string {
    if (!this.apiKeyValue) throw new SDKError('SDK API key missing', 'SDK_API_KEY_MISSING')
    return this.apiKeyValue
  }

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

  setInitPromise(promise: Promise<Readonly<RemoteConfigResponse> | undefined> | null): void {
    this.initPromise = promise
  }

  getInitPromise(): Promise<Readonly<RemoteConfigResponse> | undefined> | null {
    return this.initPromise
  }

  registerPlugin(plugin: SDKPlugin): void {
    if (this.pluginRegistry.some(existing => existing.meta.name === plugin.meta.name)) {
      throw new SDKError(`Plugin "${plugin.meta.name}" is already registered`, 'DUPLICATE_PLUGIN', {
        pluginName: plugin.meta.name,
      })
    }
    this.pluginRegistry.push(plugin)
  }

  registerEventProcessor(processor: EventProcessor): void {
    this.eventProcessorRegistry.push(processor)
  }

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
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value as Readonly<T>
}
