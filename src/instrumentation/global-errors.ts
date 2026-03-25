import { captureError } from "../capture/captureError.js"

export function setupGlobalErrorHandlers() {
  process.on("uncaughtException", (err) => {
    captureError(err, { mechanism: "uncaughtException" })
  })

  process.on("unhandledRejection", (reason: any) => {
    const error = reason instanceof Error
      ? reason
      : new Error(String(reason))

    captureError(error, { mechanism: "unhandledRejection" })
  })
}