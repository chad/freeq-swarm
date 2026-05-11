import { describe, expect, it } from 'vitest';
import { createWorkerClaimer, evaluateEligibility } from './claim.js';
import type { CapabilityAdvertisement, WorkerConfig, InboundCoordinationEvent } from '@freeq-swarm/shared';

const CAP: CapabilityAdvertisement = {
  kind: 'swarm.capabilities/v1',
  worker_did: 'did:key:wA',
  operator_did: 'did:plc:op',
  advertised: {
    task_types: ['pr_review'],
    models: [{ provider: 'anthropic', model: 'claude-opus-4-7', via: 'api' }],
    max_concurrent: 1,
    languages: ['typescript'],
    max_diff_kloc: 10,
  },
  constraints: {
    allowed_repo_patterns: ['github.com/foo/*'],
    max_usd_per_task: 1.5,
    idle_only: true,
  },
};

const WORKER_CFG: WorkerConfig = {
  worker: {
    nick_hint: 'wA',
    swarm_channels: ['#swarm'],
    freeq_server: 'irc.freeq.at:6697',
    owner_did: 'did:plc:op',
  },
  capabilities: {
    task_types: ['pr_review'],
    max_concurrent: 1,
    languages: ['typescript'],
    max_diff_kloc: 10,
  },
  runtime: { models: [{ provider: 'anthropic', model: 'claude-opus-4-7', via: 'api' }] },
  constraints: {
    allowed_repo_patterns: ['github.com/foo/*'],
    max_usd_per_task: 1.5,
    idle_only: true,
  },
  governance: { on_pause: 'complete_in_flight' },
};

const TASK_OK = {
  task_type: 'pr_review',
  target: { repo: 'github.com/foo/bar' },
  spec: { diff_url: 'https://x' },
  policy: { max_usd_per_reviewer: 1.5 },
};

describe('evaluateEligibility', () => {
  it('eligible on idle worker matching capability', () => {
    const r = evaluateEligibility({ task: TASK_OK, capability: CAP, config: WORKER_CFG, presence: 'idle', inFlight: 0 });
    expect(r.eligible).toBe(true);
  });

  it('rejects when not idle', () => {
    expect(evaluateEligibility({ task: TASK_OK, capability: CAP, config: WORKER_CFG, presence: 'executing', inFlight: 0 }).eligible).toBe(false);
  });

  it('rejects when at concurrency cap', () => {
    expect(evaluateEligibility({ task: TASK_OK, capability: CAP, config: WORKER_CFG, presence: 'idle', inFlight: 1 }).eligible).toBe(false);
  });

  it('rejects when task_type not advertised', () => {
    const t = { ...TASK_OK, task_type: 'doc_gen' };
    expect(evaluateEligibility({ task: t, capability: CAP, config: WORKER_CFG, presence: 'idle', inFlight: 0 }).eligible).toBe(false);
  });

  it('rejects when repo not in allowlist', () => {
    const t = { ...TASK_OK, target: { repo: 'github.com/random/r' } };
    expect(evaluateEligibility({ task: t, capability: CAP, config: WORKER_CFG, presence: 'idle', inFlight: 0 }).eligible).toBe(false);
  });

  it('rejects when est_usd > worker max_usd_per_task', () => {
    const cfg = { ...WORKER_CFG, constraints: { ...WORKER_CFG.constraints, max_usd_per_task: 0.0001 } };
    expect(evaluateEligibility({ task: TASK_OK, capability: CAP, config: cfg, presence: 'idle', inFlight: 0 }).eligible).toBe(false);
  });

  it('rejects when task max_usd_per_reviewer < est', () => {
    const t = { ...TASK_OK, policy: { max_usd_per_reviewer: 0.0001 } };
    expect(evaluateEligibility({ task: t, capability: CAP, config: WORKER_CFG, presence: 'idle', inFlight: 0 }).eligible).toBe(false);
  });
});

function makeRequestEvent(taskId = '01HZN'): InboundCoordinationEvent {
  return {
    source: 'coord!u@h',
    verb: 'TAGMSG',
    channel: '#swarm',
    eventType: 'task_request',
    eventId: taskId,
    payload: {
      kind: 'swarm.task/v1',
      task_type: 'pr_review',
      requester_did: 'did:plc:r',
      target: { repo: 'github.com/foo/bar', pr: 1, head_sha: 'abc' },
      spec: { diff_url: 'https://x' },
      policy: {
        reviewers_needed: 2,
        claim_window_ms: 30000,
        execution_timeout_ms: 300000,
        max_usd_per_reviewer: 1.5,
      },
    },
    tags: {},
  };
}

describe('createWorkerClaimer', () => {
  function makeClient(): { sentLines: string[]; client: any } {
    const sentLines: string[] = [];
    return {
      sentLines,
      client: { raw: (l: string) => sentLines.push(l) },
    };
  }

  it('emits task_accept TAGMSG + PRIVMSG when eligible', () => {
    const c = makeClient();
    const claimer = createWorkerClaimer({
      client: c.client,
      workerDid: 'did:key:wA',
      config: WORKER_CFG,
      capability: CAP,
      channels: ['#swarm'],
      getPresence: () => 'idle',
      getInFlight: () => 0,
    });
    claimer(makeRequestEvent());
    const accepts = c.sentLines.filter((l) => /event=task_accept/.test(l));
    expect(accepts.length).toBe(2);
  });

  it('does not claim when ineligible', () => {
    const c = makeClient();
    const claimer = createWorkerClaimer({
      client: c.client,
      workerDid: 'did:key:wA',
      config: WORKER_CFG,
      capability: CAP,
      channels: ['#swarm'],
      getPresence: () => 'executing',
      getInFlight: () => 1,
    });
    claimer(makeRequestEvent());
    expect(c.sentLines).toHaveLength(0);
  });

  it('ignores task_requests on other channels', () => {
    const c = makeClient();
    const claimer = createWorkerClaimer({
      client: c.client,
      workerDid: 'did:key:wA',
      config: WORKER_CFG,
      capability: CAP,
      channels: ['#other'],
      getPresence: () => 'idle',
      getInFlight: () => 0,
    });
    claimer(makeRequestEvent());
    expect(c.sentLines).toHaveLength(0);
  });

  it('ignores non-task_request events', () => {
    const c = makeClient();
    const claimer = createWorkerClaimer({
      client: c.client,
      workerDid: 'did:key:wA',
      config: WORKER_CFG,
      capability: CAP,
      channels: ['#swarm'],
      getPresence: () => 'idle',
      getInFlight: () => 0,
    });
    const evt = makeRequestEvent();
    evt.eventType = 'task_complete';
    claimer(evt);
    expect(c.sentLines).toHaveLength(0);
  });

  it('ignores malformed payload', () => {
    const c = makeClient();
    const claimer = createWorkerClaimer({
      client: c.client,
      workerDid: 'did:key:wA',
      config: WORKER_CFG,
      capability: CAP,
      channels: ['#swarm'],
      getPresence: () => 'idle',
      getInFlight: () => 0,
    });
    const evt = makeRequestEvent();
    (evt as any).payload = null;
    claimer(evt);
    expect(c.sentLines).toHaveLength(0);
  });

  it('reports onIneligible reason for tests', () => {
    const c = makeClient();
    const reasons: Array<[string, string]> = [];
    const claimer = createWorkerClaimer({
      client: c.client,
      workerDid: 'did:key:wA',
      config: WORKER_CFG,
      capability: CAP,
      channels: ['#swarm'],
      getPresence: () => 'idle',
      getInFlight: () => 1,
      onIneligible: (id, r) => reasons.push([id, r]),
    });
    claimer(makeRequestEvent('TASK1'));
    expect(reasons).toEqual([['TASK1', 'at concurrency cap (1/1)']]);
  });
});
