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
export async function sendEvents(events) {
    try {
        const res = await fetch(`${DEFAULT_BASE_URL}/events`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ events }),
        });
        if (!res.ok) {
            throw new Error(`Failed: ${res.status}`);
        }
        console.log(`[SDK] Sent ${events.length} events`);
    }
    catch (err) {
        console.error("[SDK] sendEvents error");
        //  simple retry (basic version)
        setTimeout(() => {
            sendEvents(events);
        }, 2000);
    }
}
//# sourceMappingURL=sender.js.map