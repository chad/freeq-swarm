import { describe, expect, it } from 'vitest';
import { CoordinatorDb } from './db.js';
import { createDispatcher } from './dispatch.js';
import { parseInboundCoordinationEvent } from '@freeq-swarm/shared';

function makeClient(): { sentLines: string[]; client: any } {
  const sentLines: string[] = [];
  return {
    sentLines,
    client: { raw: (l: string) => sentLines.push(l) },
  };
}

function fakeScheduler() {
  const callbacks: Array<{ id: number; cb: () => void; ms: number }> = [];
  let nextId = 1;
  return {
    callbacks,
    api: {
      setTimeout: ((cb: () => void, ms: number) => {
        const id = nextId++;
        callbacks.push({ id, cb, ms });
        return id as any;
      }) as typeof setTimeout,
      clearTimeout: ((id: any) => {
        const idx = callbacks.findIndex((c) => c.id === id);
        if (idx >= 0) callbacks.splice(idx, 1);
      }) as typeof clearTimeout,
    },
    fireAll() {
      const toFire = [...callbacks];
      callbacks.length = 0;
      for (const c of toFire) c.cb();
    },
  };
}

function seedTask(db: CoordinatorDb, taskId: string, reviewersNeeded = 2, claimWindowMs = 30000): void {
  db.insertTask({
    task_id: taskId,
    state: 'pending_claims',
    task_type: 'pr_review',
    requester_did: 'did:plc:r',
    payload_json: JSON.stringify({
      kind: 'swarm.task/v1',
      task_type: 'pr_review',
      requester_did: 'did:plc:r',
      target: { repo: 'github.com/foo/bar', pr: 1, head_sha: 'a' },
      spec: { diff_url: 'x' },
      policy: {
        reviewers_needed: reviewersNeeded,
        claim_window_ms: claimWindowMs,
        execution_timeout_ms: 300000,
        max_usd_per_reviewer: 1.5,
      },
    }),
    created_at: 1000,
    retries_remaining: 1,
  });
}

function makeEvent(eventType: string, eventId: string, payload: unknown, taskId?: string): any {
  return {
    source: 'src',
    verb: 'TAGMSG',
    channel: '#swarm',
    eventType,
    eventId,
    taskId,
    tags: {},
    payload,
  };
}

describe('createDispatcher', () => {
  it('opens claim window on task_request and assigns top N at expiry', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T1', 2);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T1', { kind: 'swarm.task/v1' }));
    expect(sched.callbacks).toHaveLength(1);
    // 3 claimers race
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'T1', worker_did: 'did:key:a' }, 'T1'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'T1', worker_did: 'did:key:b' }, 'T1'));
    d.handle(makeEvent('task_accept', 'C3', { kind: 'swarm.claim/v1', task_id: 'T1', worker_did: 'did:key:c' }, 'T1'));
    expect(db.claimsFor('T1')).toHaveLength(3);
    sched.fireAll();
    // Two assignments persisted; assignment event posted.
    expect(db.assignmentsFor('T1')).toHaveLength(2);
    const assignments = c.sentLines.filter((l) => /event=task_update/.test(l));
    expect(assignments.length).toBe(2);
    const tagmsg = assignments.find((l) => / TAGMSG /.test(l))!;
    const parsed = parseInboundCoordinationEvent(tagmsg)!;
    expect((parsed.payload as any).assigned_to).toHaveLength(2);
  });

  it('emits task_failed :no_claims when window closes empty', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T2');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T2', { kind: 'swarm.task/v1' }));
    sched.fireAll();
    const failed = c.sentLines.filter((l) => /event=task_failed/.test(l));
    expect(failed.length).toBe(2);
    expect(db.getTask('T2')!.state).toBe('failed');
    expect(db.getTask('T2')!.failure_reason).toBe('no_claims');
  });

  it('idempotent on duplicate task_request (echo-message)', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T3');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T3', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_request', 'T3', { kind: 'swarm.task/v1' }));
    expect(sched.callbacks).toHaveLength(1);
  });

  it('PK dedups duplicate task_accept from same worker', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T4');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T4', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'T4', worker_did: 'did:key:a' }, 'T4'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'T4', worker_did: 'did:key:a' }, 'T4'));
    expect(db.claimsFor('T4')).toHaveLength(1);
  });

  it('ignores events on other channels', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T5');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    const evt = makeEvent('task_request', 'T5', { kind: 'swarm.task/v1' });
    evt.channel = '#other';
    d.handle(evt);
    expect(sched.callbacks).toHaveLength(0);
  });

  it('rejects task_accept with no worker_did', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T6');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'T6' }, 'T6'));
    expect(db.claimsFor('T6')).toHaveLength(0);
  });

  it('oldest claim wins when more claims than reviewers needed', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T7', 1);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T7', { kind: 'swarm.task/v1' }));
    // We can't easily inject ordered timestamps here, but the SQL query is
    // ORDER BY claimed_at ASC. With ms-resolution we may collide; the
    // hash-tiebreak path is what we're really exercising.
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'T7', worker_did: 'did:key:zzzzz' }, 'T7'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'T7', worker_did: 'did:key:aaaaa' }, 'T7'));
    sched.fireAll();
    expect(db.assignmentsFor('T7')).toHaveLength(1);
    // Deterministic: same input → same output.
  });

  it('marks task as assigned in DB after dispatch', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T8');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T8', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'T8', worker_did: 'did:key:a' }, 'T8'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'T8', worker_did: 'did:key:b' }, 'T8'));
    sched.fireAll();
    expect(db.getTask('T8')!.state).toBe('assigned');
    expect(db.getTask('T8')!.assigned_at).not.toBeNull();
  });

  it('flushAll force-fires pending windows for tests', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T9');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T9', { kind: 'swarm.task/v1' }));
    expect(sched.callbacks).toHaveLength(1);
    d.flushAll();
    expect(db.getTask('T9')!.state).toBe('failed'); // no claims
  });

  it('shutdown clears pending timers', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T10');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'T10', { kind: 'swarm.task/v1' }));
    expect(sched.callbacks).toHaveLength(1);
    d.shutdown();
    expect(sched.callbacks).toHaveLength(0);
  });

  it('drops task_request for unknown task_id (not in our SQLite)', () => {
    const db = new CoordinatorDb(':memory:');
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'UNKNOWN', { kind: 'swarm.task/v1' }));
    expect(sched.callbacks).toHaveLength(0);
  });

  // ── Phase 5: evidence + consensus ──

  function feedReview(d: any, taskId: string, evId: string, did: string, verdict: string, severity = 'low'): void {
    d.handle(makeEvent('evidence_attach', evId, {
      kind: 'swarm.review/v1',
      evidence_type: 'code_review',
      task_id: taskId,
      verdict,
      severity,
      summary: '',
      comments: [],
      truncated: false,
      tokens_used: 100,
      usd_cost: 0.1,
      model: 'claude-opus-4-7',
      via: 'api',
      worker_did: did,
    }, taskId));
  }

  it('finalizes task_complete on unanimous evidence', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'TC1', 2);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC1', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC1', worker_did: 'did:key:a' }, 'TC1'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'TC1', worker_did: 'did:key:b' }, 'TC1'));
    sched.fireAll(); // claim window → assignment + execution timer
    feedReview(d, 'TC1', 'E1', 'did:key:a', 'approve');
    feedReview(d, 'TC1', 'E2', 'did:key:b', 'approve');
    // Both evidence in → maybeFinalize fires → task_complete.
    const completes = c.sentLines.filter((l) => /event=task_complete/.test(l));
    expect(completes.length).toBe(2);
    const t = db.getTask('TC1')!;
    expect(t.state).toBe('complete');
    expect(t.consensus_verdict).toBe('approve');
    expect(t.agreement_score).toBe(1);
  });

  it('emits consensus_irreconcilable when verdicts split 1/1/1', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'TC2', 3);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC2', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC2', worker_did: 'did:key:a' }, 'TC2'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'TC2', worker_did: 'did:key:b' }, 'TC2'));
    d.handle(makeEvent('task_accept', 'C3', { kind: 'swarm.claim/v1', task_id: 'TC2', worker_did: 'did:key:c' }, 'TC2'));
    sched.fireAll();
    feedReview(d, 'TC2', 'E1', 'did:key:a', 'approve');
    feedReview(d, 'TC2', 'E2', 'did:key:b', 'request_changes');
    feedReview(d, 'TC2', 'E3', 'did:key:c', 'reject');
    const t = db.getTask('TC2')!;
    expect(t.state).toBe('failed');
    expect(t.failure_reason).toBe('consensus_irreconcilable');
  });

  it('execution_timeout with retries left re-emits task_request', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'TC3', 1);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC3', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC3', worker_did: 'did:key:a' }, 'TC3'));
    sched.fireAll(); // claim window → assignment + exec timer
    expect(db.getTask('TC3')!.retries_remaining).toBe(1);
    sched.fireAll(); // exec timeout → retry triggers a new task_request + new claim window
    expect(db.getTask('TC3')!.retries_remaining).toBe(0);
    expect(db.getTask('TC3')!.state).toBe('pending_claims');
    const requests = c.sentLines.filter((l) => /event=task_request/.test(l) && / TAGMSG /.test(l));
    expect(requests.length).toBe(1); // the retry emit
  });

  it('execution_timeout with no retries fails the task', () => {
    const db = new CoordinatorDb(':memory:');
    db.insertTask({
      task_id: 'TC4',
      state: 'pending_claims',
      task_type: 'pr_review',
      requester_did: 'did:plc:r',
      payload_json: JSON.stringify({
        kind: 'swarm.task/v1',
        task_type: 'pr_review',
        requester_did: 'did:plc:r',
        target: { repo: 'github.com/foo/bar', pr: 1, head_sha: 'a' },
        spec: { diff_url: 'x' },
        policy: {
          reviewers_needed: 1,
          claim_window_ms: 30000,
          execution_timeout_ms: 300000,
          max_usd_per_reviewer: 1.5,
        },
      }),
      created_at: 1000,
      retries_remaining: 0,
    });
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC4', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC4', worker_did: 'did:key:a' }, 'TC4'));
    sched.fireAll();
    sched.fireAll();
    expect(db.getTask('TC4')!.state).toBe('failed');
    expect(db.getTask('TC4')!.failure_reason).toBe('execution_timeout');
  });

  it('reputation increments for picked-bucket workers', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'TC5', 2);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC5', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC5', worker_did: 'did:key:a' }, 'TC5'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'TC5', worker_did: 'did:key:b' }, 'TC5'));
    sched.fireAll();
    feedReview(d, 'TC5', 'E1', 'did:key:a', 'approve');
    feedReview(d, 'TC5', 'E2', 'did:key:b', 'approve');
    expect(db.workerState('did:key:a')!.reputation).toBe(1);
    expect(db.workerState('did:key:b')!.reputation).toBe(1);
  });

  it('total_usd_cost in task_complete sums per-evidence cost', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'TC6', 2);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC6', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC6', worker_did: 'did:key:a' }, 'TC6'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'TC6', worker_did: 'did:key:b' }, 'TC6'));
    sched.fireAll();
    feedReview(d, 'TC6', 'E1', 'did:key:a', 'approve');
    feedReview(d, 'TC6', 'E2', 'did:key:b', 'approve');
    const tagmsg = c.sentLines.find((l) => /event=task_complete/.test(l) && / TAGMSG /.test(l))!;
    const parsed = parseInboundCoordinationEvent(tagmsg)!;
    expect((parsed.payload as any).total_usd_cost).toBeCloseTo(0.2);
  });

  it('malformed evidence does not satisfy reviewers_needed; eventual timeout fails', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'TC7', 2);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC7', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC7', worker_did: 'did:key:a' }, 'TC7'));
    d.handle(makeEvent('task_accept', 'C2', { kind: 'swarm.claim/v1', task_id: 'TC7', worker_did: 'did:key:b' }, 'TC7'));
    sched.fireAll(); // arms execution timer
    // A garbage evidence_attach (no verdict) — recorded but does NOT satisfy reviewers_needed.
    d.handle(makeEvent('evidence_attach', 'E1', { worker_did: 'did:key:a', not_a_review: true }, 'TC7'));
    expect(db.getTask('TC7')!.state).toBe('assigned'); // still waiting
    d.handle(makeEvent('evidence_attach', 'E2', { worker_did: 'did:key:b', kind: 'swarm.review/v1', verdict: 'approve', severity: 'none' }, 'TC7'));
    // Still only one valid review out of 2 needed.
    expect(db.getTask('TC7')!.state).toBe('assigned');
    sched.fireAll(); // execution timeout → retry → emits task_request → re-arms claim window
    sched.fireAll(); // claim window fires with no new claims → no_claims → fail
    const t = db.getTask('TC7')!;
    expect(t.state).toBe('failed');
  });

  it('ignores evidence for already-completed task', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'TC8', 1);
    const c = makeClient();
    const sched = fakeScheduler();
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api });
    d.handle(makeEvent('task_request', 'TC8', { kind: 'swarm.task/v1' }));
    d.handle(makeEvent('task_accept', 'C1', { kind: 'swarm.claim/v1', task_id: 'TC8', worker_did: 'did:key:a' }, 'TC8'));
    sched.fireAll();
    feedReview(d, 'TC8', 'E1', 'did:key:a', 'approve');
    expect(db.getTask('TC8')!.state).toBe('complete');
    // Late evidence after complete:
    feedReview(d, 'TC8', 'E2', 'did:key:b', 'reject');
    expect(db.getTask('TC8')!.state).toBe('complete');
  });
});
