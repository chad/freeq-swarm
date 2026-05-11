// Worker-side governance signal handler. PLAN §4.4.
//
// Subscribes to the SDK's raw stream, filters for TAGMSGs that carry a
// +freeq.at/governance=<signal> tag and target *us*, and translates each
// signal into the documented worker response (presence transition,
// claim-loop pause, etc.).
import { type GovernanceSignal, parseGovernance } from '@freeq-swarm/shared';
import type { FreeqClient } from '@freeq/sdk';

export type GovernanceState = 'normal' | 'paused' | 'blocked_on_budget' | 'revoked';

export interface GovernanceHandlerArgs {
  client: FreeqClient;
  /** Our current nick — server PAUSEs target nick. */
  nick: () => string;
  /** Set our presence (called inside the handler for ACK transitions). */
  setPresence: (state: 'idle' | 'paused' | 'blocked_on_budget' | 'offline', extra?: string) => void;
  /** Called when state transitions, e.g. for the dispatch-loop to pause/resume. */
  onStateChange: (state: GovernanceState, signal: GovernanceSignal | 'init') => void;
  /** Called on `revoke` so caller can exit the process. */
  onRevoke: () => void;
}

export interface GovernanceHandle {
  state: () => GovernanceState;
  /** Test hook: feed in a raw IRC line as if from the wire. */
  feed: (line: string) => void;
  /** Unsubscribe from the SDK. */
  dispose: () => void;
}

export function attachGovernanceHandler(args: GovernanceHandlerArgs): GovernanceHandle {
  let state: GovernanceState = 'normal';

  const handleSignal = (signal: GovernanceSignal): void => {
    switch (signal) {
      case 'pause':
        if (state === 'revoked') return;
        state = 'paused';
        args.setPresence('paused', 'paused by issuer');
        args.onStateChange(state, signal);
        break;
      case 'resume':
        if (state === 'revoked') return;
        state = 'normal';
        args.setPresence('idle');
        args.onStateChange(state, signal);
        break;
      case 'revoke':
        state = 'revoked';
        args.onStateChange(state, signal);
        args.onRevoke();
        break;
      case 'budget_exceeded':
        if (state === 'revoked') return;
        state = 'blocked_on_budget';
        args.setPresence('blocked_on_budget', 'budget exceeded');
        args.onStateChange(state, signal);
        break;
      case 'approval_granted':
      case 'approval_denied':
        // v1 doesn't issue APPROVAL_REQUEST so we just log + ignore.
        break;
    }
  };

  const onLine = (line: string, _parsed: any): void => {
    const g = parseGovernance(line);
    if (!g) return;
    const myNick = args.nick().toLowerCase();
    if (g.target.toLowerCase() !== myNick) return;
    handleSignal(g.signal);
  };

  args.client.on('raw', onLine);

  return {
    state: () => state,
    feed: (line) => onLine(line, null),
    dispose: () => args.client.off('raw', onLine),
  };
}
