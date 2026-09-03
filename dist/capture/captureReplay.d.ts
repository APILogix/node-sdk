/**
 * Public session-replay capture API.
 *
 * Emits a replay segment event (`type: 'replay'`) to the `replays`
 * ingestion route. Gated by the `sessionReplay` entitlement: when the plan
 * does not include session replay, calls are silently dropped (no-op).
 *
 * The event pipeline applies privacy scrubbing (sensitive-field redaction
 * + PII masking) to every entry in the segment before transport.
 */
/**
 * Capture a session-replay segment.
 *
 * @param sessionId - Replay session identifier the segment belongs to
 * @param segmentId - Monotonically increasing segment number within the session
 * @param events - Recorded replay entries (DOM mutations, interactions, …)
 *
 * No-op when the `sessionReplay` entitlement is revoked by remote config.
 */
export declare function captureReplay(sessionId: string, segmentId: number, events: readonly unknown[]): void;
