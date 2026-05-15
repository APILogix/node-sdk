import { captureError } from "../capture/captureError.js";
import { toError } from "../core/errors.js";
let registered = false;
export function setupGlobalErrorHandlers() {
    if (registered)
        return;
    registered = true;
    process.on("uncaughtException", (err) => {
        captureError(err, { mechanism: "uncaughtException" });
    });
    process.on("unhandledRejection", (reason) => {
        captureError(toError(reason), { mechanism: "unhandledRejection" });
    });
}
//# sourceMappingURL=global-errors.js.map