import  type { RemoteConfig } from "../types/config.js"
import   { client } from "./client.js"

export function setRemoteConfig(config: RemoteConfig) {
  client.setConfig(config)
}

export function getConfig(): RemoteConfig {
  if (!client.config) {
    throw new Error("SDK not initialized")
  }
  return client.config
}