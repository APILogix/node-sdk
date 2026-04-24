
export { init } from "./core/init.js"
export { flush, shutdown } from "./core/lifecycle.js"
export { getConfig } from "./core/config.js"
export { SDKError } from "./core/errors.js"
export type { Logger } from "./utils/logger.js"

//  expose middleware (public API)
export { monitorMiddleware } from "./instrumentation/express.js"

export { captureError } from "./capture/captureError.js"
export { captureRequest } from "./capture/captureRequest.js"
