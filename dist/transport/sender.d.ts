import type { Event } from '../types/event.js';
export interface InitResponse {
    success: boolean;
    projectId?: string;
    config?: unknown;
    ingestion?: unknown;
}
export declare function sendInitRequest(apiKey: string, baseUrl: string, timeoutMs?: number): Promise<InitResponse>;
export declare function sendEvents(events: Event[]): Promise<void>;
//# sourceMappingURL=sender.d.ts.map