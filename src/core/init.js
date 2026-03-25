import { client } from "./client.js";
import { sendInitRequest } from "../transport/sender.js";
import { setRemoteConfig } from "./config.js";
import { startBatcher } from "../transport/batcher.js";
export async function init(options) {
    if (client.initialized) {
        console.warn("[SDK] Already initialized");
        return;
    }
    try {
        client.setOptions(options);
        console.log("[SDK] Initializing...", options);
        const response = await sendInitRequest(options.apiKey, options.apiSecret, options.projectId);
        if (!response.success) {
            throw new Error("Invalid init response");
        }
        setRemoteConfig(response.config);
        client.markInitialized();
        startBatcher();
        console.log("[SDK] Initialized successfully");
    }
    catch (err) {
        console.error("[SDK] Init failed:", err);
        // never crash app
        client.initialized = false;
    }
}
