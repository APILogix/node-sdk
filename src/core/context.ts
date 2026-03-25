import { AsyncLocalStorage } from "async_hooks"

type Store = {
  requestId: string
}

export const asyncLocalStorage = new AsyncLocalStorage<Store>()

export function getRequestContext(): Store | undefined {
  return asyncLocalStorage.getStore()
}