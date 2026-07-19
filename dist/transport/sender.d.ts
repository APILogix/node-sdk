import type { Event } from '../types/event.js';
export interface InitResponse {
    success: boolean;
    projectId?: string;
    plan?: string;
    planFeatures?: Record<string, unknown>;
    config?: unknown;
    ingestion?: unknown;
}
export declare function sendInitRequest(apiKey: string, baseUrl: string, timeoutMs?: number): Promise<InitResponse>;
export declare function sendEvents(events: Event[]): Promise<void>;
export declare function validateApiKey(apiKey: string): void;
//# sourceMappingURL=sender.d.ts.map