import type { ResolvedSDKConfig } from "../types/config.js"
import { client } from "./client.js"

/**
 * Get the resolved SDK configuration.
 * Throws if SDK is not initialized.
 */
export function getConfig(): Readonly<ResolvedSDKConfig> {
  return client.config
}
