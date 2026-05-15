import { client } from "./client.js";
export function setRemoteConfig(config) {
    client.setConfig(config);
}
export function getConfig() {
    return client.config;
}
//# sourceMappingURL=config.js.map