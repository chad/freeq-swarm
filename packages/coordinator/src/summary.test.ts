import { describe, expect, it } from 'vitest';
import { CoordinatorDb } from './db.js';
import {
  buildStats,
  nextFireMs,
  renderSummaryLines,
  startSummaryScheduler,
} from './summary.js';
import { createDidCache, operatorAllowlistFromDids } from '@freeq-swarm/shared';

describe('buildStats', () => {
  it('empty tasks → zero stats', () => {
    const s = buildStats([]);
    expect(s.total).toBe(0);
    expect(s.approved).toBe(0);
    expect(s.needsAttention).toEqual([]);
  });

  it('counts approved + buckets request_changes/reject as needsAttention', () => {
    const t1 = makeTask({ task_id: 'T1', state: 'complete', consensus_verdict: 'approve' });
    const t2 = makeTask({ task_id: 'T2', state: 'complete', consensus_verdict: 'approve_with_comments' });
    const t3 = makeTask({ task_id: 'T3', state: 'complete', consensus_verdict: 'request_changes' });
    const t4 = makeTask({ task_id: 'T4', state: 'complete', consensus_verdict: 'reject' });
    const t5 = makeTask({ task_id: 'T5', state: 'failed', failure_reason: 'consensus_irreconcilable' });
    const s = buildStats([t1, t2, t3, t4, t5]);
    expect(s.total).toBe(5);
    expect(s.approved).toBe(2);
    expect(s.needsAttention.map((t) => t.task_id)).toEqual(['T3', 'T4', 'T5']);
  });
});

describe('renderSummaryLines', () => {
  it('emits the expected header / bullets / audit footer', () => {
    const lines = renderSummaryLines({
      date: new Date('2026-05-11T09:00:00Z'),
      stats: {
        total: 7,
        approved: 5,
        needsAttention: [
          makeTask({
            task_id: '01HZN12345',
            state: 'failed',
            failure_reason: 'consensus_irreconcilable',
          }),
        ],
        totalUsd: 1.84,
        contributorCounts: new Map([['did:key:bob', 4]]),
      },
      channel: '#swarm',
      sinceUnix: 1715000000,
      topContributors: [['did:key:bob', 4]],
    });
    expect(lines[0]).toBe('☀️ Swarm summary 2026-05-11');
    expect(lines.some((l) => l.includes('7 tasks completed (5 approved)'))).toBe(true);
    expect(lines.some((l) => l.includes('1 need your attention'))).toBe(true);
    expect(lines.some((l) => l.includes('consensus_irreconcilable'))).toBe(true);
    expect(lines.some((l) => l.includes('$1.84'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  Audit:'))).toBe(true);
  });
});

describe('nextFireMs', () => {
  it('fires today when target time is in the future (UTC)', () => {
    const now = new Date('2026-05-11T08:00:00Z');
    const ms = nextFireMs({ now, hhmm: '09:00', tz: 'UTC' });
    expect(ms).toBe(60 * 60 * 1000); // 1 hour
  });

  it('fires tomorrow when target time has passed (UTC)', () => {
    const now = new Date('2026-05-11T10:00:00Z');
    const ms = nextFireMs({ now, hhmm: '09:00', tz: 'UTC' });
    // 23 hours
    expect(ms).toBe(23 * 60 * 60 * 1000);
  });

  it('handles non-UTC tz approximately', () => {
    // Just check it produces a positive < 48h delta for any tz.
    const now = new Date('2026-05-11T15:00:00Z');
    const ms = nextFireMs({ now, hhmm: '09:00', tz: 'Europe/London' });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(48 * 60 * 60 * 1000);
  });
});

describe('startSummaryScheduler', () => {
  it('sendNow emits PRIVMSG lines to the requester nick', async () => {
    const db = new CoordinatorDb(':memory:');
    db.insertTask({
      task_id: 'T1',
      state: 'pending_claims',
      task_type: 'pr_review',
      requester_did: 'did:plc:alice',
      payload_json: '{}',
      created_at: 1000,
      retries_remaining: 0,
    });
    db.setTaskComplete({
      task_id: 'T1',
      consensus_verdict: 'approve',
      consensus_severity: 'none',
      agreement_score: 1,
      completed_at: Math.floor(Date.now() / 1000),
    });
    db.insertEvidence({
      event_id: 'E1',
      task_id: 'T1',
      worker_did: 'did:key:bob',
      payload_json: JSON.stringify({ kind: 'swarm.review/v1', usd_cost: 0.13 }),
      received_at: 1000,
    });
    const sentLines: string[] = [];
    const fakeClient: any = { raw: (l: string) => sentLines.push(l) };
    const didCache = createDidCache({
      whois: () => {},
      onMemberDid: () => () => {},
      defaultTimeoutMs: 50,
    });
    didCache.set('alice', 'did:plc:alice');
    const fakeSched = {
      setTimeout: (() => 0) as any,
      clearTimeout: (() => {}) as any,
    };
    const h = startSummaryScheduler({
      client: fakeClient,
      db,
      config: {
        swarm: { channel: '#swarm', founder_did: 'did:plc:f', coordinator_nick: 'swarm', freeq_server: 's' },
        operator_allowlist: ['did:plc:alice'],
        task_types: {} as any,
        budget: { daily_usd_per_agent: 5 },
        summary: { default_tz: 'UTC', default_time: '09:00', per_requester_tz: {} },
      } as any,
      didCache,
      operatorAllowlist: await operatorAllowlistFromDids(['did:plc:alice']),
      scheduler: fakeSched,
    });
    await h.sendNow('did:plc:alice');
    h.shutdown();
    const dms = sentLines.filter((l) => l.startsWith('PRIVMSG alice '));
    expect(dms.length).toBeGreaterThan(0);
    expect(dms.some((l) => l.includes('1 task completed'))).toBe(true);
    expect(dms.some((l) => l.includes('$0.13'))).toBe(true);
  });

  it('sendNow no-ops when nick unknown', async () => {
    const db = new CoordinatorDb(':memory:');
    const sentLines: string[] = [];
    const fakeClient: any = { raw: (l: string) => sentLines.push(l) };
    const didCache = createDidCache({
      whois: () => {},
      onMemberDid: () => () => {},
      defaultTimeoutMs: 50,
    });
    const h = startSummaryScheduler({
      client: fakeClient,
      db,
      config: {
        swarm: { channel: '#swarm', founder_did: 'did:plc:f', coordinator_nick: 'swarm', freeq_server: 's' },
        operator_allowlist: ['did:plc:alice'],
        task_types: {} as any,
        budget: { daily_usd_per_agent: 5 },
        summary: { default_tz: 'UTC', default_time: '09:00', per_requester_tz: {} },
      } as any,
      didCache,
      operatorAllowlist: await operatorAllowlistFromDids(['did:plc:alice']),
      scheduler: { setTimeout: (() => 0) as any, clearTimeout: (() => {}) as any },
    });
    await h.sendNow('did:plc:alice'); // no nick known
    h.shutdown();
    expect(sentLines).toHaveLength(0);
  });
});

function makeTask(overrides: Partial<import('./db.js').TaskRow> = {}): import('./db.js').TaskRow {
  return {
    task_id: 'T1',
    state: 'complete',
    task_type: 'pr_review',
    requester_did: 'did:plc:alice',
    payload_json: '{}',
    created_at: 0,
    assigned_at: null,
    completed_at: 0,
    consensus_verdict: null,
    consensus_severity: null,
    agreement_score: null,
    failure_reason: null,
    failure_detail: null,
    retries_remaining: 0,
    ...overrides,
  } as import('./db.js').TaskRow;
}
