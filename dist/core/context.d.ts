import { AsyncLocalStorage } from "async_hooks";
type Store = {
    requestId: string;
};
export declare const asyncLocalStorage: AsyncLocalStorage<Store>;
export declare function getRequestContext(): Store | undefined;
export {};
//# sourceMappingURL=context.d.ts.map