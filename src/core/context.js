import { AsyncLocalStorage } from "async_hooks";
export const asyncLocalStorage = new AsyncLocalStorage();
export function getRequestContext() {
    return asyncLocalStorage.getStore();
}
