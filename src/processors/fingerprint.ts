import { createHash } from "crypto"

export function generateFingerprint(error: Error, stackFrames: any[]) {
  const base = [
    error.name,
    ...stackFrames.map(f => f.function),
    ...stackFrames.map(f => f.file),
  ].join("|")

  return createHash("sha1").update(base).digest("hex")
}