import { SDKError } from './errors.js';
const VALID_TRANSITIONS = {
    created: new Set(['initializing', 'stopping']),
    initializing: new Set(['initialized', 'recovering', 'stopping']),
    initialized: new Set(['initialized', 'stopping']),
    recovering: new Set(['initializing', 'initialized', 'recovering', 'stopping', 'stopped']),
    stopping: new Set(['stopped']),
    stopped: new Set(['created']),
};
export class LifecycleStateMachine {
    currentState = 'created';
    getState() {
        return this.currentState;
    }
    canTransitionTo(nextState) {
        const allowed = VALID_TRANSITIONS[this.currentState];
        return allowed ? allowed.has(nextState) : false;
    }
    transition(nextState) {
        if (this.currentState === nextState && (nextState === 'recovering' || nextState === 'initialized')) {
            return this.currentState;
        }
        if (!this.canTransitionTo(nextState)) {
            throw new SDKError(`Invalid SDK state transition from '${this.currentState}' to '${nextState}'`, 'INVALID_STATE_TRANSITION', { from: this.currentState, to: nextState });
        }
        this.currentState = nextState;
        return this.currentState;
    }
    reset() {
        this.currentState = 'created';
    }
}
