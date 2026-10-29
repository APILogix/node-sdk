export class SDKError extends Error {
    code;
    context;
    constructor(message, code, context = {}, cause) {
        super(message, { cause });
        this.name = "SDKError";
        this.code = code;
        this.context = context;
    }
}
export function toError(value) {
    if (value instanceof Error)
        return value;
    if (typeof value === "string")
        return new Error(value);
    if (value && typeof value === 'object') {
        const record = value;
        const msg = typeof record.message === 'string' && record.message
            ? record.message
            : (() => { try {
                return JSON.stringify(value);
            }
            catch {
                return String(value);
            } })();
        const err = new Error(msg);
        if (typeof record.name === 'string')
            err.name = record.name;
        if (typeof record.stack === 'string')
            err.stack = record.stack;
        if (typeof record.statusCode === 'number')
            err.statusCode = record.statusCode;
        if (typeof record.status === 'number')
            err.status = record.status;
        if (typeof record.code === 'string' || typeof record.code === 'number')
            err.code = record.code;
        return err;
    }
    return new Error(String(value));
}
export function extractErrorCauseChain(error, maxDepth = 5) {
    const chain = [];
    let cur = error;
    while (cur && cur.cause && chain.length < maxDepth) {
        cur = cur.cause;
        chain.push({ name: cur.name ?? 'Error', message: cur.message ?? String(cur), stack: cur.stack });
    }
    return chain;
}
