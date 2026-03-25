import { DEFAULT_BASE_URL } from '../constants/defaults.js';
export async function sendInitRequest(apiKey, apiSecret, projectId) {
    const res = await fetch(`${DEFAULT_BASE_URL}/sdk/init`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'x-api-secret': apiSecret
        },
        body: JSON.stringify({ projectId })
    });
    console.log('[SDK] Init response status:', res);
    if (!res.ok) {
        throw new Error(`SDK init failed: ${res.status}`);
    }
    return res.json();
}
//# sourceMappingURL=sender.js.map