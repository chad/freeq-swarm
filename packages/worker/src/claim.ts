// Worker claim logic. PLAN §5.5.
//
// On inbound task_request: evaluate eligibility against capability + constraints;
// if eligible AND presence=idle AND assignments_in_flight < max_concurrent,
// post task_accept TAGMSG + companion PRIVMSG. Otherwise drop silently.
//
// Tracks assigned tasks so worker won't over-commit.
import {
  type CapabilityAdvertisement,
  type InboundCoordinationEvent,
  type WorkerConfig,
  EVENT_TYPES,
  buildCoordinationEvent,
  estimateUsd,
  matchesAnyRepoPattern,
} from '@freeq-swarm/shared';
import type { FreeqClient } from '@freeq/sdk';

export type WorkerPresenceState = 'online' | 'idle' | 'executing' | 'paused' | 'blocked_on_budget' | 'offline';

export interface WorkerClaimerArgs {
  client: FreeqClient;
  workerDid: string;
  config: WorkerConfig;
  capability: CapabilityAdvertisement;
  /** Channels we are JOINed in. We only claim tasks posted here. */
  channels: readonly string[];
  /** Returns the worker's current presence (Phase 1 sets this to 'idle' after cap-ad). */
  getPresence: () => WorkerPresenceState;
  /** Returns the count of in-flight assignments for the worker. */
  getInFlight: () => number;
  /** Optional eligibility logger for tests. */
  onIneligible?: (taskId: string, reason: string) => void;
  /** Optional onClaim hook for tests; called BEFORE the IRC raw send. */
  onClaim?: (taskId: string) => void;
}

export interface ClaimEligibility {
  eligible: boolean;
  reason?: string;
}

/** Pure eligibility computation. */
export function evaluateEligibility(args: {
  task: {
    task_type: string;
    target: { repo: string };
    spec: { diff_url?: string };
    policy: { max_usd_per_reviewer: number };
  };
  capability: CapabilityAdvertisement;
  config: WorkerConfig;
  presence: WorkerPresenceState;
  inFlight: number;
}): ClaimEligibility {
  const { task, capability, config, presence, inFlight } = args;
  if (presence !== 'idle' && config.constraints.idle_only) {
    return { eligible: false, reason: `presence=${presence} (idle_only)` };
  }
  if (inFlight >= capability.advertised.max_concurrent) {
    return { eligible: false, reason: `at concurrency cap (${inFlight}/${capability.advertised.max_concurrent})` };
  }
  if (!capability.advertised.task_types.includes(task.task_type)) {
    return { eligible: false, reason: `task_type ${task.task_type} not in capabilities` };
  }
  if (!matchesAnyRepoPattern(task.target.repo, config.constraints.allowed_repo_patterns)) {
    return { eligible: false, reason: `repo ${task.target.repo} not in worker allowlist` };
  }
  // Cost pre-check (rough): assume the diff is at most max_diff_kloc * 1024 bytes.
  const maxDiffBytes = capability.advertised.max_diff_kloc * 1024;
  const model = config.runtime.models[0]?.model ?? '';
  const est = estimateUsd(model, maxDiffBytes);
  if (est !== null && est > config.constraints.max_usd_per_task) {
    return { eligible: false, reason: `worst-case est_usd ${est.toFixed(3)} > max_usd_per_task ${config.constraints.max_usd_per_task}` };
  }
  if (task.policy.max_usd_per_reviewer < (est ?? 0)) {
    return {
      eligible: false,
      reason: `task max_usd_per_reviewer ${task.policy.max_usd_per_reviewer} < est ${est}`,
    };
  }
  return { eligible: true };
}

/**
 * Construct the worker claimer. Returns a `handle` fn that takes an inbound
 * coordination event and may post a `task_accept`.
 */
export function createWorkerClaimer(args: WorkerClaimerArgs): (evt: InboundCoordinationEvent) => void {
  const { client, workerDid, config, capability, channels, getPresence, getInFlight } = args;
  const channelSet = new Set(channels.map((c) => c.toLowerCase()));

  return (evt: InboundCoordinationEvent): void => {
    if (evt.eventType !== EVENT_TYPES.task_request) return;
    if (!channelSet.has(evt.channel.toLowerCase())) return;
    const task = evt.payload as any;
    if (typeof task !== 'object' || task === null) return;
    if (task.kind !== 'swarm.task/v1') return;

    const elig = evaluateEligibility({
      task,
      capability,
      config,
      presence: getPresence(),
      inFlight: getInFlight(),
    });
    if (!elig.eligible) {
      args.onIneligible?.(evt.eventId, elig.reason ?? '');
      return;
    }

    args.onClaim?.(evt.eventId);

    const claimPayload = {
      kind: 'swarm.claim/v1' as const,
      task_id: evt.eventId,
      worker_did: workerDid,
    };
    const out = buildCoordinationEvent(evt.channel, EVENT_TYPES.task_accept, claimPayload, {
      humanText: `🙋 claiming ${evt.eventId.slice(0, 8)}`,
      taskId: evt.eventId,
    });
    client.raw(out.tagmsg);
    client.raw(out.privmsg);
  };
}
