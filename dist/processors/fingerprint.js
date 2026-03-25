import { createHash } from "crypto";
export function generateFingerprint(error, stackFrames) {
    const base = [
        error.name,
        ...stackFrames.map(f => f.function),
        ...stackFrames.map(f => f.file),
    ].join("|");
    return createHash("sha1").update(base).digest("hex");
}
//# sourceMappingURL=fingerprint.js.map