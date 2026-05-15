// `whoareyou` discovery handler. Responds to a DM from a prospective worker
// with a swarm.discovery/v1 payload describing the channel's policy + runtime
// hints, so the worker can auto-bootstrap with one approval prompt.
import {
  type CoordinatorConfig,
  type OperatorAllowlist,
  type SwarmDiscovery,
  type DidCache,
} from '@freeq-swarm/shared';
import type { FreeqClient } from '@freeq/sdk';

export interface DiscoveryDeps {
  client: FreeqClient;
  config: CoordinatorConfig;
  coordinatorDid: string;
  /** For sender-DID resolution. */
  didCache: DidCache;
  operatorAllowlist: OperatorAllowlist;
  /** Free-form description sent in the discovery payload (optional). */
  description?: string;
}

const TRIGGER = /^\s*(?:whoareyou|wai|describe)\s*$/i;

export interface InboundPrivmsg {
  target: string;
  from: string;
  text: string;
}

/**
 * Handle a candidate `whoareyou` DM. The worker is expected to PRIVMSG the
 * coordinator's nick with the literal text "whoareyou" (or `wai` / `describe`).
 *
 * We respond with a single PRIVMSG carrying the SwarmDiscovery payload as
 * percent-encoded JSON in a `+freeq.at/swarm-discovery=` tag. We also send a
 * human-readable summary as PRIVMSG body so an irssi user can read it.
 */
export function handleDiscoveryRequest(
  deps: DiscoveryDeps,
  msg: InboundPrivmsg,
): void {
  // Only DMs (target is our coordinator nick) trigger this.
  if (msg.target.toLowerCase() !== deps.config.swarm.coordinator_nick.toLowerCase()) return;
  if (!TRIGGER.test(msg.text)) return;
  // Union of allowed_repo_patterns across all configured task types — workers
  // need to accept tasks from any of them. Per-task cap picks the highest
  // recommended ceiling so worker config doesn't accidentally underprovision.
  const taskTypes = Object.keys(deps.config.task_types);
  const allowedPatterns = new Set<string>();
  let maxUsdPerTask = 0;
  for (const tt of taskTypes) {
    const c = deps.config.task_types[tt]!;
    for (const p of c.allowed_repo_patterns) allowedPatterns.add(p);
    if (c.max_usd_per_reviewer > maxUsdPerTask) maxUsdPerTask = c.max_usd_per_reviewer;
  }
  // For software-factory mode (issue_fix), we recommend `via: cli` so the
  // worker can shell out to `claude` for agentic edits. Otherwise default to api.
  const includesFix = taskTypes.includes('issue_fix');
  const payload: SwarmDiscovery = {
    kind: 'swarm.discovery/v1',
    swarm_name: deps.config.swarm.channel.replace(/^#/, ''),
    channel: deps.config.swarm.channel,
    founder_did: deps.config.swarm.founder_did,
    coordinator_did: deps.coordinatorDid,
    coordinator_nick: deps.config.swarm.coordinator_nick,
    task_types: taskTypes,
    recommended: {
      model: 'claude-opus-4-7',
      via: includesFix ? 'cli' : 'api',
      max_concurrent: 1,
      languages: ['typescript', 'rust', 'python'],
      max_diff_kloc: 10,
    },
    policy: {
      allowed_repo_patterns: [...allowedPatterns],
      max_usd_per_task: maxUsdPerTask,
      daily_usd_per_agent: deps.config.budget.daily_usd_per_agent,
    },
    operator_allowlist_hint: deps.operatorAllowlist.list().map((e) => e.did),
    description: deps.description,
  };
  const json = JSON.stringify(payload);
  // Send as an in-band PRIVMSG with the payload base64url-encoded in a tag,
  // and a short summary in the body so non-swarm clients see something useful.
  const b64 = Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const summary = `swarm:${payload.swarm_name} channel=${payload.channel} repos=${payload.policy.allowed_repo_patterns.join(',')} budget=$${payload.policy.daily_usd_per_agent}/day`;
  const safeFrom = msg.from.replace(/[\r\n\0 ]/g, '');
  // The discovery payload tag value is intentionally NOT under the
  // +freeq.at/* coordination namespace because we want plain freeq clients
  // to render the body, not interpret it as a coordination event.
  deps.client.raw(`@swarm.discovery/v1=${b64} PRIVMSG ${safeFrom} :${summary.replace(/[\r\n\0]/g, ' ')}`);
}

// parseDiscoveryResponse lives in shared/discovery.ts so the worker can import it.
export { parseDiscoveryResponse } from '@freeq-swarm/shared';
