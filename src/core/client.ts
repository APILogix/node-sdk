import { createHash } from "crypto"
import  type { RemoteConfig, SDKInitOptions } from "../types/config.js"
import { SDKError } from "./errors.js"

class SDKClient {
  private static instance: SDKClient

  private configValue: Readonly<RemoteConfig> | null = null
  private initPromise: Promise<Readonly<RemoteConfig>> | null = null
  private apiKeyValue: string | null = null
  private initIdentityValue: string | null = null
  private pendingInitIdentityValue: string | null = null

  private constructor() {}

  static getInstance() {
    if (!SDKClient.instance) {
      SDKClient.instance = new SDKClient()
    }
    return SDKClient.instance
  }

  get initialized() {
    return this.configValue !== null
  }

  get config(): Readonly<RemoteConfig> {
    if (!this.configValue) {
      throw new SDKError("SDK not initialized", "SDK_NOT_INITIALIZED")
    }

    return this.configValue
  }

  setOptions(options: SDKInitOptions) {
    this.apiKeyValue = options.apiKey
    this.initIdentityValue = createInitIdentity(options)
  }

  setConfig(config: RemoteConfig) {
    this.configValue = deepFreeze(structuredClone(config))
  }

  clearConfig() {
    this.configValue = null
  }

  clear() {
    this.configValue = null
    this.apiKeyValue = null
    this.initIdentityValue = null
    this.pendingInitIdentityValue = null
    this.initPromise = null
  }

  getApiKey() {
    if (!this.apiKeyValue) {
      throw new SDKError("SDK API key missing", "SDK_API_KEY_MISSING")
    }

    return this.apiKeyValue
  }

  hasSameIdentity(options: SDKInitOptions) {
    return this.initIdentityValue === createInitIdentity(options)
  }

  setPendingIdentity(options: SDKInitOptions) {
    this.pendingInitIdentityValue = createInitIdentity(options)
  }

  clearPendingIdentity() {
    this.pendingInitIdentityValue = null
  }

  hasSamePendingIdentity(options: SDKInitOptions) {
    return this.pendingInitIdentityValue === createInitIdentity(options)
  }

  setInitPromise(promise: Promise<Readonly<RemoteConfig>> | null) {
    this.initPromise = promise
  }

  getInitPromise() {
    return this.initPromise
  }
}

export const client = SDKClient.getInstance()

function createInitIdentity(options: SDKInitOptions) {
  return createHash("sha256")
    .update(options.apiKey)
    .digest("hex")
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested)
    }
    Object.freeze(value)
  }

  return value as Readonly<T>
}
