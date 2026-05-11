import { describe, expect, it } from 'vitest';
import { CoordinatorDb } from './db.js';

function freshDb(): CoordinatorDb {
  return new CoordinatorDb(':memory:');
}

describe('CoordinatorDb', () => {
  it('round-trips meta', () => {
    const db = freshDb();
    expect(db.getMeta('x')).toBeNull();
    db.setMeta('x', '1');
    expect(db.getMeta('x')).toBe('1');
    db.setMeta('x', '2');
    expect(db.getMeta('x')).toBe('2');
  });

  it('lastSeenEventTs accessor', () => {
    const db = freshDb();
    expect(db.lastSeenEventTs).toBe(0);
    db.lastSeenEventTs = 1234;
    expect(db.lastSeenEventTs).toBe(1234);
  });

  it('insertTask + getTask', () => {
    const db = freshDb();
    db.insertTask({
      task_id: '01H',
      state: 'pending_claims',
      task_type: 'pr_review',
      requester_did: 'did:plc:r',
      payload_json: '{}',
      created_at: 1000,
      retries_remaining: 1,
    });
    const t = db.getTask('01H');
    expect(t).not.toBeNull();
    expect(t!.state).toBe('pending_claims');
    expect(t!.requester_did).toBe('did:plc:r');
  });

  it('claims with PK dedup', () => {
    const db = freshDb();
    db.insertTask({
      task_id: '01H',
      state: 'pending_claims',
      task_type: 'pr_review',
      requester_did: 'did:plc:r',
      payload_json: '{}',
      created_at: 1000,
      retries_remaining: 1,
    });
    db.recordClaim('01H', 'did:key:a', 1100);
    db.recordClaim('01H', 'did:key:a', 1101); // dup ignored
    db.recordClaim('01H', 'did:key:b', 1102);
    const claims = db.claimsFor('01H');
    expect(claims).toHaveLength(2);
    expect(claims[0]!.worker_did).toBe('did:key:a');
    expect(claims[0]!.claimed_at).toBe(1100);
    expect(claims[1]!.worker_did).toBe('did:key:b');
  });

  it('openAssignmentsByWorker tracks in-flight', () => {
    const db = freshDb();
    for (const id of ['T1', 'T2', 'T3']) {
      db.insertTask({
        task_id: id,
        state: 'assigned',
        task_type: 'pr_review',
        requester_did: 'did:plc:r',
        payload_json: '{}',
        created_at: 1000,
        retries_remaining: 1,
      });
    }
    db.recordAssignment('T1', 'did:key:a', 1100);
    db.recordAssignment('T2', 'did:key:a', 1100);
    db.recordAssignment('T3', 'did:key:b', 1100);
    // worker a: 2 open
    let m = db.openAssignmentsByWorker();
    expect(m.get('did:key:a')).toBe(2);
    expect(m.get('did:key:b')).toBe(1);
    // a posts evidence for T1
    db.insertEvidence({
      event_id: 'E1',
      task_id: 'T1',
      worker_did: 'did:key:a',
      payload_json: '{}',
      received_at: 1200,
    });
    m = db.openAssignmentsByWorker();
    expect(m.get('did:key:a')).toBe(1); // T1 evidence in
    expect(m.get('did:key:b')).toBe(1);
    // T3 completes
    db.setTaskComplete({
      task_id: 'T3',
      consensus_verdict: 'approve',
      consensus_severity: 'low',
      agreement_score: 1.0,
      completed_at: 1300,
    });
    m = db.openAssignmentsByWorker();
    expect(m.get('did:key:b')).toBeUndefined();
  });

  it('upsertCapability replaces on conflict', () => {
    const db = freshDb();
    db.upsertCapability({
      worker_did: 'did:key:a',
      operator_did: 'did:plc:o',
      payload_json: '{"v":1}',
      updated_at: 1000,
    });
    db.upsertCapability({
      worker_did: 'did:key:a',
      operator_did: 'did:plc:o',
      payload_json: '{"v":2}',
      updated_at: 2000,
    });
    expect(db.allCapabilities()).toHaveLength(1);
    expect(db.capabilityFor('did:key:a')!.payload_json).toBe('{"v":2}');
  });

  it('reputation accumulates additively', () => {
    const db = freshDb();
    db.bumpReputation('did:key:a', 1);
    db.bumpReputation('did:key:a', 2);
    expect(db.workerState('did:key:a')!.reputation).toBe(3);
  });

  it('did_to_nick survives upsert', () => {
    const db = freshDb();
    db.saveDidNick('did:plc:abc', 'alice', 100);
    db.saveDidNick('did:plc:abc', 'alice2', 200);
    const pairs = db.loadDidNickPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ did: 'did:plc:abc', nick: 'alice2' });
  });

  it('inFlightTasks excludes terminal states', () => {
    const db = freshDb();
    for (const [id, state] of [
      ['T1', 'pending_claims'],
      ['T2', 'assigned'],
      ['T3', 'verifying'],
      ['T4', 'complete'],
      ['T5', 'failed'],
    ] as const) {
      db.insertTask({
        task_id: id,
        state,
        task_type: 'pr_review',
        requester_did: 'did:plc:r',
        payload_json: '{}',
        created_at: 1000,
        retries_remaining: 1,
      });
    }
    const ids = db.inFlightTasks().map((t) => t.task_id).sort();
    expect(ids).toEqual(['T1', 'T2', 'T3']);
  });

  it('recentTasksFor filters by requester + completed_at', () => {
    const db = freshDb();
    db.insertTask({
      task_id: 'T1',
      state: 'pending_claims',
      task_type: 'pr_review',
      requester_did: 'did:plc:r',
      payload_json: '{}',
      created_at: 1000,
      retries_remaining: 1,
    });
    db.setTaskComplete({
      task_id: 'T1',
      consensus_verdict: 'approve',
      consensus_severity: 'low',
      agreement_score: 1,
      completed_at: 5000,
    });
    expect(db.recentTasksFor('did:plc:r', 4000)).toHaveLength(1);
    expect(db.recentTasksFor('did:plc:r', 6000)).toHaveLength(0);
    expect(db.recentTasksFor('did:plc:other', 0)).toHaveLength(0);
  });
});
