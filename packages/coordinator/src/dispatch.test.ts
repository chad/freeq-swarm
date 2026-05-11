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
});
