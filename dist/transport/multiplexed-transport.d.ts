import type { EnterpriseRoute } from './route-registry.js';
export interface MultiplexedBatch {
    route: EnterpriseRoute;
    events: unknown[];
}
export interface MultiplexedPayload {
    batches: MultiplexedBatch[];
    timestamp: number;
    sdk: string;
}
export declare class MultiplexedTransport {
    private baseUrl;
    private apiKey;
    private flushIntervalMs;
    private flushTimer;
    private pendingBatches;
    private destroyed;
    private flushing;
    constructor(baseUrl: string, apiKey: string, flushIntervalMs?: number);
    enqueue(route: EnterpriseRoute, events: unknown[]): void;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    isEnabled(): boolean;
}
//# sourceMappingURL=multiplexed-transport.d.ts.map