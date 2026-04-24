import  type { RemoteConfig } from "../types/config.js"
import   { client } from "./client.js"

export function setRemoteConfig(config: RemoteConfig) {
  client.setConfig(config)
}

export function getConfig(): Readonly<RemoteConfig> {
  return client.config
}
