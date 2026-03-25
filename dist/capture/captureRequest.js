import { client } from "../core/client.js";
export function captureRequest(event) {
    if (!client.initialized)
        return;
    const config = client.config;
    if (!config?.enablePerformance)
        return;
    // Sampling
    if (Math.random() > config.samplingRate)
        return;
    // 🔥 For now just log (next phase → queue)
    console.log("[SDK REQUEST EVENT]", event);
}
//# sourceMappingURL=captureRequest.js.map