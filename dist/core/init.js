import { client } from "./client.js";
import { sendInitRequest } from "../transport/sender.js";
import { setRemoteConfig } from "./config.js";
export async function init(options) {
    if (client.initialized) {
        console.warn("SDK already initialized");
        return;
    }
    const baseUrl = options.baseUrl || "http://localhost:4000";
    try {
        client.setOptions(options);
        const response = await sendInitRequest(baseUrl, options.apiKey, options.projectId);
        setRemoteConfig(response.config);
        client.markInitialized();
        console.log("SDK initialized successfully");
    }
    catch (err) {
        console.error("SDK init failed:", err);
        // IMPORTANT: Fail silently in production
    }
}
//# sourceMappingURL=init.js.map