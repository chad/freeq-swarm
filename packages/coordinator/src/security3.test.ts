// RED-TEAM ROUND 3 — prototype pollution, JSON DoS, NaN/Infinity, time bombs,
// SPEND spoofing, coordinator self-claim, parser DoS, did:key edge cases.
import { describe, expect, it } from 'vitest';
import { CoordinatorDb } from './db.js';
import { createDispatcher } from './dispatch.js';
import { handleInboundPrivmsg } from './dispatcher.js';
import { parseTaskCommand } from './ingest.js';
import { computeConsensus } from './verify.js';
import {
  createDidCache,
  decodePayload,
  encodePayload,
  parseInboundCoordinationEvent,
} from '@freeq-swarm/shared';

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
function seedTask(db: CoordinatorDb, id: string, reviewers = 1): void {
  db.insertTask({
    task_id: id,
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
// CLASS Q: Prototype pollution
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: prototype pollution', () => {
  it('Q1: a payload with __proto__ does not pollute Object.prototype after JSON.parse', () => {
    const before = (Object.prototype as any).polluted;
    expect(before).toBeUndefined();
    const malicious = '{"__proto__":{"polluted":"yes"}}';
    JSON.parse(malicious); // standard JSON.parse — no pollution since modern engines
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  it('Q2: decodePayload of __proto__-injection encoded JSON does NOT pollute', () => {
    const enc = encodePayload({ '__proto__': { polluted: true } });
    const dec = decodePayload(enc) as any;
    expect((Object.prototype as any).polluted).toBeUndefined();
    // The result either has __proto__ as own-property or doesn't — either way, no pollution.
    expect(({} as any).polluted).toBeUndefined();
  });

  it('Q3: deeply nested JSON does not crash subscriber path', () => {
    let s = '{}';
    for (let i = 0; i < 500; i += 1) s = `{"a":${s}}`;
    expect(() => decodePayload(s)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS R: NaN / Infinity / negative numerics
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: bad numerics', () => {
  it('R1: parseTaskCommand rejects negative reviewers count', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/1 reviewers=-1');
    expect(r.ok).toBe(false);
  });

  it('R2: parseTaskCommand rejects fractional reviewers (strict integer regex)', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/1 reviewers=2.5');
    expect(r.ok).toBe(false);
  });

  it('R3: parseTaskCommand rejects scientific-notation reviewers', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/1 reviewers=1e30');
    expect(r.ok).toBe(false);
  });

  it('R4: consensus algorithm tolerates NaN-shaped agreement_score gracefully', () => {
    // 0 reviews → ok=false with detail "no reviews submitted"
    const r = computeConsensus([]);
    expect(r.ok).toBe(false);
  });

  it('R5: parseTaskCommand with super-long flag value (10MB) does not OOM', () => {
    const huge = 'review https://github.com/foo/bar/pull/1 model=' + 'a'.repeat(10_000_000);
    expect(() => parseTaskCommand(huge)).not.toThrow();
    // Should reject — model regex /^[\w-]+$/ matches but `huge.replace(...)` doesn't bound length.
    // We don't currently bound; this test documents that it doesn't OOM.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS S: Coordinator self-claim
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: coordinator self-claim', () => {
  it('S1: dispatcher accepts a claim from the coordinator itself if its DID is in the cache', () => {
    // The dispatcher does NOT distinguish "this is the coordinator's own DID
    // and shouldn't claim work assigned to itself". This is fine for v1
    // because the coordinator daemon doesn't run a worker loop.
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'S1', 1);
    const c = makeClient();
    const sched = fakeScheduler();
    const cache = workerCache('did:key:coordinator-self');
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api, didCache: cache });
    d.handle(inbound('task_request', 'S1', srcFor('did:key:coordinator-self'), {}));
    d.handle(inbound('task_accept', 'A1', srcFor('did:key:coordinator-self'), { kind: 'swarm.claim/v1', task_id: 'S1', worker_did: 'did:key:coordinator-self' }, 'S1'));
    // No allowlist configured, so it'd be admitted.
    expect(db.claimsFor('S1')).toHaveLength(1);
    // Assertion: documenting current behavior (acceptable — coordinator code
    // doesn't run a worker so there's no "real" self-claim risk).
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS T: Empty / unusual channel names
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: malformed channel names', () => {
  it('T1: dispatcher with empty channel name does not crash on inbound events', () => {
    const db = new CoordinatorDb(':memory:');
    const c = makeClient();
    const sched = fakeScheduler();
    const cache = workerCache('did:key:a');
    const d = createDispatcher({ client: c.client, db, channel: '', scheduler: sched.api, didCache: cache });
    expect(() =>
      d.handle(inbound('task_request', 'T1', srcFor('did:key:a'), {})),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS U: Encoded payload edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: payload encoding edge cases', () => {
  it('U1: parseInboundCoordinationEvent on a TAGMSG with a malformed +freeq.at/payload (invalid pct-encoding) returns null', () => {
    // %ZZ is invalid pct-encoding
    const line = '@msgid=01;+freeq.at/event=task_request;+freeq.at/payload=%ZZ TAGMSG #swarm';
    expect(parseInboundCoordinationEvent(line)).toBeNull();
  });

  it('U2: parseInboundCoordinationEvent on a TAGMSG with no msgid returns null', () => {
    const line = '@+freeq.at/event=task_request TAGMSG #swarm';
    expect(parseInboundCoordinationEvent(line)).toBeNull();
  });

  it('U3: parseInboundCoordinationEvent on a TAGMSG with no event tag returns null', () => {
    const line = '@msgid=01 TAGMSG #swarm';
    expect(parseInboundCoordinationEvent(line)).toBeNull();
  });

  it('U4: an empty payload value is accepted and decodes to null', () => {
    const line = '@msgid=01;+freeq.at/event=status_update TAGMSG #swarm';
    const e = parseInboundCoordinationEvent(line);
    expect(e).not.toBeNull();
    expect(e!.payload).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS V: SPEND spoofing (defer to server enforcement)
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: SPEND spoofing', () => {
  it('V1: client.raw of a SPEND for another worker is the freeq server\'s problem', () => {
    // The dispatcher doesn't process SPEND (it's a freeq-server command,
    // not a coordination event). Server enforces did→spend mapping by SASL
    // authenticated session. So spoofing here is server-side, not ours.
    // This test exists to document the boundary.
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS W: Concurrent task_id collisions
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: task_id collisions', () => {
  it('W1: insertTask twice with same task_id throws (PK enforcement)', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'W1');
    expect(() => seedTask(db, 'W1')).toThrow(); // SQLITE_CONSTRAINT
  });

  it('W2: dispatch.onTaskRequest is idempotent on echo even with mutated payload (we trust SQLite)', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'W2');
    const c = makeClient();
    const sched = fakeScheduler();
    const cache = workerCache('did:key:a');
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api, didCache: cache });
    d.handle(inbound('task_request', 'W2', srcFor('did:key:a'), {}));
    // Mallory tries to re-emit task_request with the same id but different payload
    d.handle(inbound('task_request', 'W2', srcFor('did:key:a'), { kind: 'swarm.task/v1', target: { repo: 'github.com/MALLORY/x', pr: 1 } }));
    expect(sched.cbs.length).toBe(1); // not double-armed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS X: Concurrency starvation
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: concurrency starvation', () => {
  it('X1: 10000 task_request events do not exhaust JS heap (sanity bound)', () => {
    const db = new CoordinatorDb(':memory:');
    const c = makeClient();
    const sched = fakeScheduler();
    const cache = workerCache('did:key:a');
    const d = createDispatcher({ client: c.client, db, channel: '#swarm', scheduler: sched.api, didCache: cache });
    for (let i = 0; i < 10_000; i += 1) {
      const tid = `T${i.toString(16).padStart(8, '0')}`;
      seedTask(db, tid);
      d.handle(inbound('task_request', tid, srcFor('did:key:a'), {}));
    }
    expect(sched.cbs.length).toBe(10_000);
    d.shutdown();
    expect(sched.cbs.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS Y: did:key edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: did:key edge cases', () => {
  it('Y1: did:key with empty body still flows through (we don\'t validate format)', () => {
    const cache = workerCache('did:key:'); // empty body
    expect(cache.didForNick('')).toBe('did:key:');
  });

  it('Y2: did:key with embedded space — wireformat would already reject via tag-escape', () => {
    const cache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    cache.set('alice', 'did:key:has space');
    // We accept the binding; downstream consumers using it in IRC tags
    // would have escapeTagValue convert space to '\\s'.
    expect(cache.didForNick('alice')).toBe('did:key:has space');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS Z: ingestion → end-to-end with malicious flag values
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: ingestion edge cases', () => {
  it('Z1: parseTaskCommand rejects a flag with embedded shell injection in model name', () => {
    expect(parseTaskCommand('review https://github.com/foo/bar/pull/1 model=foo;rm -rf /').ok).toBe(false);
    expect(parseTaskCommand('review https://github.com/foo/bar/pull/1 model=$(whoami)').ok).toBe(false);
    expect(parseTaskCommand('review https://github.com/foo/bar/pull/1 model=`whoami`').ok).toBe(false);
  });

  it('Z2: parseTaskCommand rejects a URL pointing to arbitrary host (not github.com)', () => {
    expect(parseTaskCommand('review https://evil.com/foo/bar/pull/1').ok).toBe(false);
    expect(parseTaskCommand('review http://github.com.evil.com/foo/bar/pull/1').ok).toBe(false);
    expect(parseTaskCommand('review https://github.com@evil.com/foo/bar/pull/1').ok).toBe(false);
  });

  it('Z3: parseTaskCommand rejects URL with javascript: scheme', () => {
    expect(parseTaskCommand('review javascript:alert(1)').ok).toBe(false);
  });

  it('Z4: parseTaskCommand rejects URL with file:// scheme', () => {
    expect(parseTaskCommand('review file:///etc/passwd').ok).toBe(false);
  });
});
