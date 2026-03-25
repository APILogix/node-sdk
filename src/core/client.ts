import  type { RemoteConfig, SDKInitOptions } from "../types/config.js"

class SDKClient {
  private static instance: SDKClient

  public config: RemoteConfig | null = null
  public options!: SDKInitOptions
  public initialized = false

  private constructor() {}

  static getInstance() {
    if (!SDKClient.instance) {
      SDKClient.instance = new SDKClient()
    }
    return SDKClient.instance
  }

  setOptions(options: SDKInitOptions) {
    this.options = options
  }

  setConfig(config: RemoteConfig) {
    this.config = config
  }

  markInitialized() {
    this.initialized = true
  }
}

export const client = SDKClient.getInstance()