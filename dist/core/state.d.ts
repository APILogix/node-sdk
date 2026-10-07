export type SDKState = 'created' | 'initializing' | 'initialized' | 'recovering' | 'stopping' | 'stopped' | 'disabled';
export declare class LifecycleStateMachine {
    private currentState;
    getState(): SDKState;
    canTransitionTo(nextState: SDKState): boolean;
    transition(nextState: SDKState): SDKState;
    reset(): void;
}
