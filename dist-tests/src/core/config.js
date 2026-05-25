import { client } from "./client.js";
/**
 * Get the resolved SDK configuration.
 * Throws if SDK is not initialized.
 */
export function getConfig() {
    return client.config;
}
