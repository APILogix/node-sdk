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
    try {
        return new Error(JSON.stringify(value));
    }
    catch {
        return new Error(String(value));
    }
}
