import { SDKError } from './errors.js'

export type SDKState =
  | 'created'
  | 'initializing'
  | 'initialized'
  | 'recovering'
  | 'stopping'
  | 'stopped'
  | 'disabled'

const VALID_TRANSITIONS: Record<SDKState, ReadonlySet<SDKState>> = {
  created: new Set(['initializing', 'stopping', 'disabled']),
  initializing: new Set(['initialized', 'recovering', 'stopping', 'disabled']),
  initialized: new Set(['initialized', 'stopping']),
  recovering: new Set(['initializing', 'initialized', 'recovering', 'stopping', 'stopped', 'disabled']),
  stopping: new Set(['stopped']),
  stopped: new Set(['created', 'disabled']),
  disabled: new Set(['initializing', 'stopping', 'disabled']),
}

export class LifecycleStateMachine {
  private currentState: SDKState = 'created'

  getState(): SDKState {
    return this.currentState
  }

  canTransitionTo(nextState: SDKState): boolean {
    const allowed = VALID_TRANSITIONS[this.currentState]
    return allowed ? allowed.has(nextState) : false
  }

  transition(nextState: SDKState): SDKState {
    if (this.currentState === nextState && (nextState === 'recovering' || nextState === 'initialized' || nextState === 'disabled')) {
      return this.currentState
    }

    if (!this.canTransitionTo(nextState)) {
      throw new SDKError(
        `Invalid SDK state transition from '${this.currentState}' to '${nextState}'`,
        'INVALID_STATE_TRANSITION',
        { from: this.currentState, to: nextState },
      )
    }

    this.currentState = nextState
    return this.currentState
  }

  reset(): void {
    this.currentState = 'created'
  }
}
