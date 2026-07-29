import type { RemoteConfigResponse } from '../types/config.js';
import type { Event } from '../types/event.js';
export interface InitResponse {
    success: boolean;
    projectId?: string;
    environment?: string;
    configRevision?: number | null;
    configHash?: string | null;
    config?: RemoteConfigResponse;
}
export declare function sendInitRequest(apiKey: string, baseUrl?: string, timeoutMs?: number): Promise<InitResponse>;
export declare function sendEvents(events: Event[]): Promise<void>;
export declare function validateApiKey(apiKey: string): void;
//# sourceMappingURL=sender.d.ts.map