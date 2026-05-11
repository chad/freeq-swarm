// END-TO-END HAPPY-PATH + FUZZ
//
// Wires CoordinatorDb + dispatcher + a fake worker that auto-claims and posts
// canned evidence. Drives one full task through ingestion → claim → assignment
// → evidence → consensus → completion. Then runs randomized fuzz batches that
// stress the consensus algorithm + dispatcher state machine.
import { describe, expect, it } from 'vitest';
import { CoordinatorDb } from './db.js';
import { createDispatcher } from './dispatch.js';
import { computeConsensus } from './verify.js';
import {
  type InboundCoordinationEvent,
  type Verdict,
  buildCoordinationEvent,
  createDidCache,
  parseInboundCoordinationEvent,
} from '@freeq-swarm/shared';

const VERDICTS: Verdict[] = ['approve', 'approve_with_comments', 'request_changes', 'reject'];

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

interface FakeWorkerArgs {
  did: string;
  verdict: Verdict;
  severity?: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

/** Minimal "worker": when it sees a task_request, it claims; when it sees an
 *  assignment naming it, it posts evidence with the configured verdict.
 *  Returns a function to feed inbound events to it. */
function fakeWorker(args: FakeWorkerArgs, onSend: (line: string) => void) {
  return (evt: InboundCoordinationEvent): void => {
    if (evt.eventType === 'task_request') {
      const out = buildCoordinationEvent(evt.channel, 'task_accept', {
        kind: 'swarm.claim/v1',
        task_id: evt.eventId,
        worker_did: args.did,
      }, { humanText: '🙋', taskId: evt.eventId });
      onSend(out.tagmsg);
      onSend(out.privmsg);
    } else if (evt.eventType === 'task_update') {
      const a = evt.payload as any;
      if (a?.kind === 'swarm.assignment/v1' && Array.isArray(a.assigned_to) && a.assigned_to.includes(args.did)) {
        const out = buildCoordinationEvent(evt.channel, 'evidence_attach', {
          kind: 'swarm.review/v1',
          evidence_type: 'code_review',
          task_id: evt.taskId ?? a.task_id,
          worker_did: args.did,
          verdict: args.verdict,
          severity: args.severity ?? 'low',
          summary: 'fuzzed review',
          comments: [],
          truncated: false,
          tokens_used: 100,
          usd_cost: 0.05,
          model: 'claude-opus-4-7',
          via: 'api',
        }, { humanText: '📎', taskId: evt.taskId ?? a.task_id, evidenceType: 'code_review' });
        onSend(out.tagmsg);
        onSend(out.privmsg);
      }
    }
  };
}

describe('END-TO-END: happy path + fuzz', () => {
  it('FF1: full pipeline — ingestion → claim → assign → evidence → complete', () => {
    const db = new CoordinatorDb(':memory:');
    const cWire = makeClient();
    const sched = fakeScheduler();
    const cache = workerCache('did:key:wA', 'did:key:wB');
    // Pre-stuff the task as if ingestion already ran.
    const taskId = 'FF1';
    db.insertTask({
      task_id: taskId,
      state: 'pending_claims',
      task_type: 'pr_review',
      requester_did: 'did:plc:requester',
      payload_json: JSON.stringify({
        kind: 'swarm.task/v1',
        task_type: 'pr_review',
        requester_did: 'did:plc:requester',
        target: { repo: 'github.com/foo/bar', pr: 42, head_sha: 'abc' },
        spec: { diff_url: 'x' },
        policy: { reviewers_needed: 2, claim_window_ms: 30000, execution_timeout_ms: 300000, max_usd_per_reviewer: 1.5 },
      }),
      created_at: 1000,
      retries_remaining: 1,
    });
    const d = createDispatcher({ client: cWire.client, db, channel: '#swarm', scheduler: sched.api, didCache: cache });

    // Spin up two fake workers. We rebroadcast our own outbound to them by
    // re-parsing from cWire.sentLines.
    const wireBuffer: string[] = [];
    const broadcast = (line: string): void => wireBuffer.push(line);
    const workers = [
      { did: 'did:key:wA', handler: fakeWorker({ did: 'did:key:wA', verdict: 'approve' }, broadcast) },
      { did: 'did:key:wB', handler: fakeWorker({ did: 'did:key:wB', verdict: 'approve' }, broadcast) },
    ];

    // Coordinator emits the task_request now (we mimic the post-ingest emit).
    const reqEvt = buildCoordinationEvent('#swarm', 'task_request',
      JSON.parse(db.getTask(taskId)!.payload_json),
      { eventId: taskId, humanText: '📋' });
    cWire.sentLines.push(reqEvt.tagmsg);
    // Feed task_request to dispatcher (it expects to see its own emit via echo).
    d.handle({
      verb: 'TAGMSG',
      channel: '#swarm',
      eventType: 'task_request',
      eventId: taskId,
      tags: {},
      payload: JSON.parse(db.getTask(taskId)!.payload_json),
      source: 'swarm!u@h',
    });
    // Feed the task_request to each fake worker.
    const reqInbound = parseInboundCoordinationEvent(reqEvt.tagmsg)!;
    for (const w of workers) w.handler(reqInbound);
    // Drain the buffer (workers' task_accepts) into the dispatcher with proper sender DIDs.
    while (wireBuffer.length > 0) {
      const line = wireBuffer.shift()!;
      const inb = parseInboundCoordinationEvent(line);
      if (!inb) continue;
      const senderDid = inb.eventType === 'task_accept'
        ? (inb.payload as any).worker_did
        : (inb.payload as any).worker_did;
      d.handle({ ...inb, source: srcFor(senderDid) });
    }
    // Fire claim-window timer to assign.
    sched.fireAll();
    // Find the assignment line in cWire.sentLines and feed to workers.
    const assignLine = cWire.sentLines.find((l) => /event=task_update/.test(l) && / TAGMSG /.test(l))!;
    const assignInbound = parseInboundCoordinationEvent(assignLine)!;
    for (const w of workers) w.handler(assignInbound);
    // Drain evidence_attach lines.
    while (wireBuffer.length > 0) {
      const line = wireBuffer.shift()!;
      const inb = parseInboundCoordinationEvent(line);
      if (!inb) continue;
      const senderDid = (inb.payload as any).worker_did;
      d.handle({ ...inb, source: srcFor(senderDid) });
    }
    // Task should now be complete.
    const t = db.getTask(taskId)!;
    expect(t.state).toBe('complete');
    expect(t.consensus_verdict).toBe('approve');
    expect(t.agreement_score).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUZZ
// ─────────────────────────────────────────────────────────────────────────────

function pseudoRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe('FUZZ: computeConsensus invariants', () => {
  it('GG1: 1000 random review batches never throw', () => {
    const r = pseudoRandom(42);
    for (let i = 0; i < 1000; i += 1) {
      const n = Math.floor(r() * 10) + 1;
      const reviews = Array.from({ length: n }, (_, j) => ({
        worker_did: `did:key:w${j}`,
        verdict: VERDICTS[Math.floor(r() * 4)] as Verdict,
        severity: (['none', 'low', 'medium', 'high', 'critical'][Math.floor(r() * 5)] as any),
      }));
      const out = computeConsensus(reviews);
      // Either ok=true with valid verdict, or ok=false with reason.
      if (out.ok) {
        expect(VERDICTS).toContain(out.verdict);
        expect(out.agreement_score).toBeGreaterThanOrEqual(0.5);
      } else {
        expect(out.reason).toBe('consensus_irreconcilable');
      }
    }
  });

  it('GG2: unanimous always picks the unanimous verdict', () => {
    const r = pseudoRandom(7);
    for (let i = 0; i < 100; i += 1) {
      const v = VERDICTS[Math.floor(r() * 4)] as Verdict;
      const reviews = Array.from({ length: 5 }, (_, j) => ({
        worker_did: `did:key:w${j}`,
        verdict: v,
        severity: 'low' as const,
      }));
      const out = computeConsensus(reviews);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.verdict).toBe(v);
        expect(out.agreement_score).toBe(1);
      }
    }
  });

  it('GG3: adding a single dissenter never flips the majority', () => {
    const r = pseudoRandom(11);
    for (let i = 0; i < 100; i += 1) {
      const v = VERDICTS[Math.floor(r() * 4)] as Verdict;
      const dissent = VERDICTS.filter((x) => x !== v)[Math.floor(r() * 3)] as Verdict;
      const reviews = [
        ...Array.from({ length: 4 }, (_, j) => ({ worker_did: `did:key:w${j}`, verdict: v, severity: 'low' as const })),
        { worker_did: 'did:key:wd', verdict: dissent, severity: 'low' as const },
      ];
      const out = computeConsensus(reviews);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.verdict).toBe(v);
    }
  });
});

describe('FUZZ: payload encoding round-trip', () => {
  it('GG4: 1000 random JSON shapes round-trip through buildCoordinationEvent + parseInboundCoordinationEvent', () => {
    const r = pseudoRandom(99);
    for (let i = 0; i < 1000; i += 1) {
      const payload: any = { i, s: `value with spaces; and ;semicolons${Math.floor(r() * 1000)}` };
      const evt = buildCoordinationEvent('#swarm', 'task_update', payload, {
        humanText: 'h',
        taskId: 'T',
      });
      const parsed = parseInboundCoordinationEvent(evt.tagmsg)!;
      expect(parsed.payload).toEqual(payload);
    }
  });
});
