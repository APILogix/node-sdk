import { client } from "./client.js";
export function setRemoteConfig(config) {
    client.setConfig(config);
}
export function getConfig() {
    if (!client.config) {
        throw new Error("SDK not initialized");
    }
    return client.config;
}
