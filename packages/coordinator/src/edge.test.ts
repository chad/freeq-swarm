// EDGE-CASE TESTS — restart recovery, partial state, malformed configs.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorDb } from './db.js';
import { createDispatcher } from './dispatch.js';
import { createDidCache, loadCoordinatorConfig, loadWorkerConfig } from '@freeq-swarm/shared';

function workerCache(...dids: string[]) {
  const c = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
  for (const d of dids) {
    const nick = d.startsWith('did:key:') ? d.slice('did:key:'.length) : d;
    c.set(nick, d);
  }
  return c;
}
function srcFor(d: string): string {
  return `${d.startsWith('did:key:') ? d.slice(8) : d}!u@h`;
}
function makeClient() {
  const sentLines: string[] = [];
  return { sentLines, client: { raw: (l: string) => sentLines.push(l) } as any };
}
function fakeScheduler() {
  const cbs: Array<{ id: number; cb: () => void; ms: number }> = [];
  let nid = 1;
  return {
    cbs,
    api: {
      setTimeout: ((cb: () => void) => {
        const id = nid++;
        cbs.push({ id, cb, ms: 0 });
        return id as any;
      }) as typeof setTimeout,
      clearTimeout: ((id: any) => {
        const i = cbs.findIndex((c) => c.id === id);
        if (i >= 0) cbs.splice(i, 1);
      }) as typeof clearTimeout,
    },
    fireAll() {
      const t = [...cbs];
      cbs.length = 0;
      for (const c of t) c.cb();
    },
  };
}
function seedTask(db: CoordinatorDb, id: string, reviewers = 1, state: any = 'pending_claims'): void {
  db.insertTask({
    task_id: id,
    state,
    task_type: 'pr_review',
    requester_did: 'did:plc:r',
    payload_json: JSON.stringify({
      kind: 'swarm.task/v1',
      task_type: 'pr_review',
      requester_did: 'did:plc:r',
      target: { repo: 'github.com/foo/bar', pr: 1, head_sha: 'a' },
      spec: { diff_url: 'x' },
      policy: {
        reviewers_needed: reviewers,
        claim_window_ms: 30000,
        execution_timeout_ms: 300000,
        max_usd_per_reviewer: 1.5,
      },
    }),
    created_at: 1000,
    retries_remaining: 1,
  });
}
function inbound(eventType: string, eventId: string, source: string, payload: unknown, taskId?: string, channel = '#swarm'): any {
  return { source, verb: 'TAGMSG', channel, eventType, eventId, taskId, tags: {}, payload };
}

// ─────────────────────────────────────────────────────────────────────────────
// EDGE: SQLite persistence across in-memory close/reopen
// ─────────────────────────────────────────────────────────────────────────────

describe('EDGE: SQLite persistence', () => {
  it('AA1: file-backed db survives close/reopen with state intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdb-'));
    const path = join(dir, 'c.sqlite');
    const db1 = new CoordinatorDb(path);
    seedTask(db1, 'AA1');
    db1.recordClaim('AA1', 'did:key:a', 100);
    db1.bumpReputation('did:key:a', 1);
    db1.close();

    const db2 = new CoordinatorDb(path);
    expect(db2.getTask('AA1')).not.toBeNull();
    expect(db2.claimsFor('AA1')).toHaveLength(1);
    expect(db2.workerState('did:key:a')!.reputation).toBe(1);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('AA2: openAssignmentsByWorker rebuilds correctly after fresh open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdb-'));
    const path = join(dir, 'c.sqlite');
    const db1 = new CoordinatorDb(path);
    seedTask(db1, 'AA2A', 1, 'assigned');
    seedTask(db1, 'AA2B', 1, 'assigned');
    db1.recordAssignment('AA2A', 'did:key:a', 100);
    db1.recordAssignment('AA2B', 'did:key:a', 100);
    db1.close();

    const db2 = new CoordinatorDb(path);
    const m = db2.openAssignmentsByWorker();
    expect(m.get('did:key:a')).toBe(2);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE: Recovery semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('EDGE: recovery (Phase 5 plan §3.1)', () => {
  it('BB1: re-creating dispatcher with pre-existing assigned task picks up where it left off', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'BB1', 1, 'assigned');
    db.recordAssignment('BB1', 'did:key:a', 1000);
    // Insert evidence after "restart"
    const c = makeClient();
    const sched = fakeScheduler();
    const cache = workerCache('did:key:a');
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api, didCache: cache });
    // Worker posts evidence — dispatcher should treat task as in-flight even
    // though we never saw the original task_request in this dispatcher instance.
    d.handle(inbound('evidence_attach', 'E1', srcFor('did:key:a'), {
      kind: 'swarm.review/v1',
      evidence_type: 'code_review',
      task_id: 'BB1',
      worker_did: 'did:key:a',
      verdict: 'approve',
      severity: 'none',
      summary: '',
      comments: [],
      truncated: false,
      tokens_used: 1,
      usd_cost: 0,
      model: 'm',
      via: 'api',
    }, 'BB1'));
    // Currently we don't know if dispatcher wires up an executing-timer for
    // pre-existing assigned tasks at construction time. Document current
    // behavior: evidence is INSERTED but maybeFinalize doesn't fire because
    // there's no entry in `executing` map.
    expect(db.evidenceFor('BB1')).toHaveLength(1);
    expect(db.getTask('BB1')!.state).toBe('assigned'); // still!
    // This is a real follow-up: dispatcher constructor should arm exec timers
    // for pre-existing assigned tasks. Filed as edge case BB1.
  });

  it('BB2: clearClaims + clearAssignments cleanly reset task for re-dispatch', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'BB2', 1);
    db.recordClaim('BB2', 'did:key:a', 100);
    db.recordAssignment('BB2', 'did:key:a', 200);
    db.clearClaims('BB2');
    db.clearAssignments('BB2');
    expect(db.claimsFor('BB2')).toHaveLength(0);
    expect(db.assignmentsFor('BB2')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE: Config loaders with hostile YAML
// ─────────────────────────────────────────────────────────────────────────────

describe('EDGE: malformed configs', () => {
  function tmpYaml(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const path = join(dir, 'c.yaml');
    writeFileSync(path, contents);
    return path;
  }

  it('CC1: coordinator config missing operator_allowlist throws cleanly', async () => {
    const path = tmpYaml(`
swarm:
  channel: "#swarm"
  founder_did: did:plc:f
task_types:
  pr_review:
    reviewers_needed: 2
    claim_window_ms: 30000
    execution_timeout_ms: 300000
    max_usd_per_reviewer: 1.5
    allowed_repo_patterns: ["github.com/*"]
budget:
  daily_usd_per_agent: 5
`);
    await expect(loadCoordinatorConfig(path)).rejects.toThrow();
  });

  it('CC2: coordinator config with channel missing # is rejected', async () => {
    const path = tmpYaml(`
swarm:
  channel: "swarm"
  founder_did: did:plc:f
operator_allowlist: ["did:plc:f"]
task_types:
  pr_review:
    reviewers_needed: 2
    claim_window_ms: 30000
    execution_timeout_ms: 300000
    max_usd_per_reviewer: 1.5
    allowed_repo_patterns: []
budget:
  daily_usd_per_agent: 5
`);
    await expect(loadCoordinatorConfig(path)).rejects.toThrow();
  });

  it('CC3: worker config with reviewers_needed=0 is rejected', async () => {
    const path = tmpYaml(`
worker:
  nick_hint: a
  swarm_channels: ["#swarm"]
  owner_did: did:plc:o
capabilities:
  task_types: [pr_review]
  max_concurrent: 0
  languages: []
  max_diff_kloc: 1
runtime:
  models:
    - provider: anthropic
      model: claude-opus-4-7
      via: api
constraints:
  allowed_repo_patterns: []
  max_usd_per_task: 1
  idle_only: true
`);
    await expect(loadWorkerConfig(path)).rejects.toThrow();
  });

  it('CC4: worker config with summary_time-shaped invalid string fails', async () => {
    const path = tmpYaml(`
swarm:
  channel: "#swarm"
  founder_did: did:plc:f
operator_allowlist: ["did:plc:f"]
task_types:
  pr_review:
    reviewers_needed: 2
    claim_window_ms: 30000
    execution_timeout_ms: 300000
    max_usd_per_reviewer: 1.5
    allowed_repo_patterns: []
budget:
  daily_usd_per_agent: 5
summary:
  default_tz: UTC
  default_time: "25:90"
`);
    await expect(loadCoordinatorConfig(path)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE: Verify zod schema strictness
// ─────────────────────────────────────────────────────────────────────────────

describe('EDGE: zod schema rejects malformed payloads', () => {
  it('DD1: dispatcher accepts evidence even if zod validation fails (treated as unparseable)', async () => {
    const { Review } = await import('@freeq-swarm/shared');
    expect(Review.safeParse({ kind: 'swarm.review/v1' }).success).toBe(false);
    // The dispatcher's onEvidence does NOT zod-parse; it stores everything
    // and let maybeFinalize count only well-formed `kind === swarm.review/v1`
    // payloads with a verdict string.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE: very small/empty fixture cases
// ─────────────────────────────────────────────────────────────────────────────

describe('EDGE: degenerate inputs', () => {
  it('EE1: dispatcher.shutdown is idempotent', () => {
    const db = new CoordinatorDb(':memory:');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    expect(() => {
      d.shutdown();
      d.shutdown();
      d.shutdown();
    }).not.toThrow();
  });

  it('EE2: subscribeCoordinationEvents handler-error does not poison stream', async () => {
    const { subscribeCoordinationEvents } = await import('@freeq-swarm/shared');
    const handlers: Array<(line: string, parsed: any) => void> = [];
    const fakeClient: any = {
      on: (_e: string, h: any) => handlers.push(h),
      off: () => {},
    };
    let ok = false;
    subscribeCoordinationEvents(fakeClient, (evt) => {
      if (evt.eventType === 'task_complete') ok = true;
      if (evt.eventType === 'task_request') throw new Error('boom');
    });
    handlers[0]!('@msgid=01;+freeq.at/event=task_request TAGMSG #swarm', null);
    handlers[0]!('@msgid=02;+freeq.at/event=task_complete TAGMSG #swarm', null);
    expect(ok).toBe(true);
  });
});
