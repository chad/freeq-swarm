// Parse +freeq.at/governance=* TAGMSG signals. PLAN §4.4.
//
// Server emits these to a specific agent via TAGMSG with the agent's nick as
// the target. Agents must respond promptly (e.g. `pause` ⇒ PRESENCE=paused
// within 10s) or be force-disconnected.
import { parseTags } from './freeq.js';

export type GovernanceSignal =
  | 'pause'
  | 'resume'
  | 'revoke'
  | 'approval_granted'
  | 'approval_denied'
  | 'budget_exceeded';

const ALL_SIGNALS = new Set<GovernanceSignal>([
  'pause',
  'resume',
  'revoke',
  'approval_granted',
  'approval_denied',
  'budget_exceeded',
]);

export interface InboundGovernance {
  signal: GovernanceSignal;
  /** Target IRC name (a nick or channel). */
  target: string;
  /** Source prefix from the IRC line (`nick!u@h` or server). */
  source?: string;
  /** Free-form detail tag value (e.g. `:reason=not_in_allowlist`). */
  detail?: string;
}

const LINE_RE = /^(?:@(\S+)\s+)?(?::(\S+)\s+)?(\S+)(?:\s+([^:]\S*(?:\s+[^:]\S*)*))?(?:\s+:(.*))?$/;

export function parseGovernance(line: string): InboundGovernance | null {
  const m = LINE_RE.exec(line.trimEnd());
  if (!m) return null;
  const [, tagsRaw, source, verb, paramsRaw] = m;
  if (!tagsRaw) return null;
  if (verb !== 'TAGMSG' && verb !== 'NOTICE' && verb !== 'PRIVMSG') return null;
  const tags = parseTags(tagsRaw);
  const sig = tags['+freeq.at/governance'];
  if (!sig || !ALL_SIGNALS.has(sig as GovernanceSignal)) return null;
  const params = paramsRaw ? paramsRaw.split(/\s+/) : [];
  const target = params[0] ?? '';
  return {
    signal: sig as GovernanceSignal,
    target,
    source,
    detail: tags['+freeq.at/detail'],
  };
}

export function isGovernanceSignal(s: string): s is GovernanceSignal {
  return ALL_SIGNALS.has(s as GovernanceSignal);
}
