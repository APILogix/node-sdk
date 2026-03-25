export async function sendInitRequest(baseUrl, apiKey, projectId) {
    const res = await fetch(`${baseUrl}/sdk/init`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
        },
        body: JSON.stringify({ projectId }),
    });
    if (!res.ok) {
        throw new Error(`SDK init failed: ${res.status}`);
    }
    return res.json();
}
//# sourceMappingURL=sender.js.map