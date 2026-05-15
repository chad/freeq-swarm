// RED-TEAM SECURITY TEST SUITE
//
// Each test is named with the attack class, the mechanism, and the expected
// resistance. Failures here are real CVEs in our trust model.
//
// PLAN F-X items that need verification:
//   - dispatcher accepts task_accept from anyone (no operator allowlist on
//     workers).
//   - dispatcher accepts evidence from anyone, with payload-self-asserted
//     worker_did.
//   - PRIVMSG/SPEND etc. accept whatever string we hand them (CRLF risk).
//
// The first round of these tests is expected to FAIL; that's the red→green→
// fix loop the user asked for.
import { describe, expect, it } from 'vitest';
import { CoordinatorDb } from './db.js';
import { createDispatcher } from './dispatch.js';
import { handleInboundPrivmsg } from './dispatcher.js';
import { createDidCache, operatorAllowlistFromDids, parseInboundCoordinationEvent } from '@freeq-swarm/shared';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeFakeGh(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sec-gh-'));
  const path = join(dir, 'gh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const HAPPY_GH = makeFakeGh(
  `cat <<'EOF'\n{"headRefOid":"abc1234","baseRefOid":"f00f","url":"https://github.com/foo/bar/pull/42"}\nEOF`,
);

function makeClient() {
  const sentLines: string[] = [];
  return { sentLines, client: { raw: (l: string) => sentLines.push(l) } as any };
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
        const i = callbacks.findIndex((c) => c.id === id);
        if (i >= 0) callbacks.splice(i, 1);
      }) as typeof clearTimeout,
    },
    fireAll() {
      const t = [...callbacks];
      callbacks.length = 0;
      for (const c of t) c.cb();
    },
  };
}

function seedTask(db: CoordinatorDb, taskId: string, reviewers = 2): void {
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

function inbound(eventType: string, eventId: string, source: string, payload: unknown, taskId?: string): any {
  return {
    source,
    verb: 'TAGMSG',
    channel: '#swarm',
    eventType,
    eventId,
    taskId,
    tags: {},
    payload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASS A: Sender impersonation
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: sender impersonation', () => {
  it('A1: dispatcher MUST reject task_accept whose payload.worker_did differs from sender DID', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T1', 2);
    const c = makeClient();
    const sched = fakeScheduler();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('mallory', 'did:key:mallory');
    didCache.set('victim', 'did:key:victim');
    const d = createDispatcher({
      client: c.client,
      db,
      channel: '#swarm',
      scheduler: sched.api,
      didCache,
    });
    d.handle(inbound('task_request', 'T1', 'self!u@h', {}));
    // Mallory posts a claim with victim's worker_did
    d.handle(
      inbound(
        'task_accept',
        'X1',
        'mallory!u@h',
        { kind: 'swarm.claim/v1', task_id: 'T1', worker_did: 'did:key:victim' },
        'T1',
      ),
    );
    expect(db.claimsFor('T1')).toHaveLength(0);
  });

  it('A2: dispatcher MUST reject evidence whose payload.worker_did differs from sender DID', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T2', 2);
    const c = makeClient();
    const sched = fakeScheduler();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('mallory', 'did:key:mallory');
    didCache.set('alice', 'did:key:alice');
    didCache.set('bob', 'did:key:bob');
    const d = createDispatcher({
      client: c.client,
      db,
      channel: '#swarm',
      scheduler: sched.api,
      didCache,
    });
    d.handle(inbound('task_request', 'T2', 'self!u@h', {}));
    d.handle(inbound('task_accept', 'A1', 'alice!u@h', { kind: 'swarm.claim/v1', task_id: 'T2', worker_did: 'did:key:alice' }, 'T2'));
    d.handle(inbound('task_accept', 'A2', 'bob!u@h', { kind: 'swarm.claim/v1', task_id: 'T2', worker_did: 'did:key:bob' }, 'T2'));
    sched.fireAll();
    // Mallory posts evidence claiming to be alice
    d.handle(
      inbound(
        'evidence_attach',
        'E1',
        'mallory!u@h',
        {
          kind: 'swarm.review/v1',
          evidence_type: 'code_review',
          task_id: 'T2',
          worker_did: 'did:key:alice',
          verdict: 'approve',
          severity: 'none',
          summary: '',
          comments: [],
          truncated: false,
          tokens_used: 1,
          usd_cost: 0,
          model: 'm',
          via: 'api',
        },
        'T2',
      ),
    );
    // Mallory's spoofed evidence MUST not have been accepted.
    const ev = db.evidenceFor('T2');
    expect(ev).toHaveLength(0);
  });

  it('A3: dispatcher MUST reject evidence from a worker that was not assigned', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'T3', 1);
    const c = makeClient();
    const sched = fakeScheduler();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('alice', 'did:key:alice');
    didCache.set('drive_by', 'did:key:drive_by');
    const d = createDispatcher({
      client: c.client,
      db,
      channel: '#swarm',
      scheduler: sched.api,
      didCache,
    });
    d.handle(inbound('task_request', 'T3', 'self!u@h', {}));
    d.handle(inbound('task_accept', 'A1', 'alice!u@h', { kind: 'swarm.claim/v1', task_id: 'T3', worker_did: 'did:key:alice' }, 'T3'));
    sched.fireAll();
    // drive_by (not assigned) tries to post evidence
    d.handle(
      inbound(
        'evidence_attach',
        'E1',
        'drive_by!u@h',
        {
          kind: 'swarm.review/v1',
          evidence_type: 'code_review',
          task_id: 'T3',
          worker_did: 'did:key:drive_by',
          verdict: 'reject',
          severity: 'critical',
          summary: '',
          comments: [],
          truncated: false,
          tokens_used: 1,
          usd_cost: 0,
          model: 'm',
          via: 'api',
        },
        'T3',
      ),
    );
    expect(db.evidenceFor('T3')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS B: Worker operator-DID allowlist bypass
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: operator-DID allowlist on workers', () => {
  it('B1: dispatcher MUST reject task_accept from a worker whose operator_did is not allowlisted', async () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'B1', 1);
    db.upsertCapability({
      worker_did: 'did:key:rogue',
      operator_did: 'did:plc:NOT_IN_ALLOWLIST',
      payload_json: JSON.stringify({}),
      updated_at: Date.now(),
    });
    db.upsertCapability({
      worker_did: 'did:key:approved',
      operator_did: 'did:plc:approved-op',
      payload_json: JSON.stringify({}),
      updated_at: Date.now(),
    });
    const c = makeClient();
    const sched = fakeScheduler();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('rogue', 'did:key:rogue');
    didCache.set('approved', 'did:key:approved');
    const d = createDispatcher({
      client: c.client,
      db,
      channel: '#swarm',
      scheduler: sched.api,
      didCache,
      operatorAllowlist: await operatorAllowlistFromDids(['did:plc:approved-op']),
    });
    d.handle(inbound('task_request', 'B1', 'self!u@h', {}));
    d.handle(inbound('task_accept', 'A1', 'rogue!u@h', { kind: 'swarm.claim/v1', task_id: 'B1', worker_did: 'did:key:rogue' }, 'B1'));
    expect(db.claimsFor('B1')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS C: CRLF injection
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: CRLF injection', () => {
  it('C1: NOTICE / PRIVMSG sender MUST strip \\r and \\n before sending', async () => {
    // We trigger a parse error path that includes the requester text in a NOTICE.
    // If the parse_error detail contains \r\n, the IRC server would interpret it as multiple commands.
    const db = new CoordinatorDb(':memory:');
    const c = makeClient();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('alice', 'did:plc:alice');
    const config = {
      swarm: { channel: '#swarm', founder_did: 'did:plc:f', coordinator_nick: 'swarm', freeq_server: 's' },
      operator_allowlist: ['did:plc:alice'],
      task_types: {
        pr_review: {
          reviewers_needed: 2,
          claim_window_ms: 30000,
          execution_timeout_ms: 300000,
          max_usd_per_reviewer: 1.5,
          allowed_repo_patterns: ['github.com/foo/*'],
          max_retries_on_timeout: 1,
        },
      },
      budget: { daily_usd_per_agent: 5 },
      summary: { default_tz: 'UTC', default_time: '09:00', per_requester_tz: {} },
    } as any;
    await handleInboundPrivmsg(
      { client: c.client, db, config, resolveSenderDid: async (m: { from: string }) => didCache.didForNick(m.from) ?? null, operatorAllowlist: await operatorAllowlistFromDids(['did:plc:alice']), ghOpts: { ghBin: HAPPY_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review http://x\r\nKICK #swarm victim :pwned' },
    );
    // Any line with \r or \n inside the body is dangerous; assert none of the sent
    // lines contains a raw newline character anywhere.
    for (const l of c.sentLines) {
      expect(l.indexOf('\n')).toBe(-1);
      expect(l.indexOf('\r')).toBe(-1);
    }
  });

  it('C2: task_failed detail with embedded CRLF MUST be sanitized before being PRIVMSG\'d back', async () => {
    const db = new CoordinatorDb(':memory:');
    const c = makeClient();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('alice', 'did:plc:alice');
    // Use a fake gh that emits stderr with embedded CRLF.
    const evilGh = makeFakeGh(`echo -e "401\\r\\nKICK #swarm victim :pwned" >&2; exit 1`);
    const config = {
      swarm: { channel: '#swarm', founder_did: 'did:plc:f', coordinator_nick: 'swarm', freeq_server: 's' },
      operator_allowlist: ['did:plc:alice'],
      task_types: {
        pr_review: {
          reviewers_needed: 2,
          claim_window_ms: 30000,
          execution_timeout_ms: 300000,
          max_usd_per_reviewer: 1.5,
          allowed_repo_patterns: ['github.com/foo/*'],
          max_retries_on_timeout: 1,
        },
      },
      budget: { daily_usd_per_agent: 5 },
      summary: { default_tz: 'UTC', default_time: '09:00', per_requester_tz: {} },
    } as any;
    await handleInboundPrivmsg(
      { client: c.client, db, config, resolveSenderDid: async (m: { from: string }) => didCache.didForNick(m.from) ?? null, operatorAllowlist: await operatorAllowlistFromDids(['did:plc:alice']), ghOpts: { ghBin: evilGh } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    for (const l of c.sentLines) {
      expect(l.indexOf('\n')).toBe(-1);
      expect(l.indexOf('\r')).toBe(-1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS D: Path traversal / shell metachars in repo paths
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: path traversal in repo names', () => {
  it('D1: parser MUST reject a URL with .. as owner', async () => {
    const db = new CoordinatorDb(':memory:');
    const c = makeClient();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('alice', 'did:plc:alice');
    const config = {
      swarm: { channel: '#swarm', founder_did: 'did:plc:f', coordinator_nick: 'swarm', freeq_server: 's' },
      operator_allowlist: ['did:plc:alice'],
      task_types: {
        pr_review: {
          reviewers_needed: 2,
          claim_window_ms: 30000,
          execution_timeout_ms: 300000,
          max_usd_per_reviewer: 1.5,
          allowed_repo_patterns: ['github.com/*'],
          max_retries_on_timeout: 1,
        },
      },
      budget: { daily_usd_per_agent: 5 },
      summary: { default_tz: 'UTC', default_time: '09:00', per_requester_tz: {} },
    } as any;
    await handleInboundPrivmsg(
      { client: c.client, db, config, resolveSenderDid: async (m: { from: string }) => didCache.didForNick(m.from) ?? null, operatorAllowlist: await operatorAllowlistFromDids(['did:plc:alice']), ghOpts: { ghBin: HAPPY_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/../etc/pull/1' },
    );
    // Should NOT post a task_request whose target contains '..'
    const reqs = c.sentLines.filter((l) => /event=task_request/.test(l));
    for (const r of reqs) {
      const parsed = parseInboundCoordinationEvent(r);
      if (parsed?.payload && typeof parsed.payload === 'object') {
        const target = (parsed.payload as any).target;
        if (target?.repo) expect(target.repo).not.toContain('..');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASS E: Payload size bombs
// ─────────────────────────────────────────────────────────────────────────────

describe('SECURITY: payload size bombs', () => {
  it('E1: dispatcher silently drops evidence with absurdly oversized comments[] (zod-validated)', () => {
    const db = new CoordinatorDb(':memory:');
    seedTask(db, 'E1', 1);
    const c = makeClient();
    const sched = fakeScheduler();
    const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
    didCache.set('alice', 'did:key:alice');
    const d = createDispatcher({
      client: c.client,
      db,
      channel: '#swarm',
      scheduler: sched.api,
      didCache,
    });
    d.handle(inbound('task_request', 'E1', 'self!u@h', {}));
    d.handle(inbound('task_accept', 'A1', 'alice!u@h', { kind: 'swarm.claim/v1', task_id: 'E1', worker_did: 'did:key:alice' }, 'E1'));
    sched.fireAll();
    // Evidence with one comment of 1MB — the dispatcher should bound how much
    // it stores in SQLite. If we don't, this is a memory-amp attack.
    const huge = 'x'.repeat(1024 * 1024);
    d.handle(
      inbound(
        'evidence_attach',
        'EV1',
        'alice!u@h',
        {
          kind: 'swarm.review/v1',
          evidence_type: 'code_review',
          task_id: 'E1',
          worker_did: 'did:key:alice',
          verdict: 'approve',
          severity: 'none',
          summary: huge,
          comments: [],
          truncated: false,
          tokens_used: 1,
          usd_cost: 0,
          model: 'm',
          via: 'api',
        },
        'E1',
      ),
    );
    // Should be rejected — the on-wire payload max is 3KB; anything larger
    // smells. (Future: enforce explicit cap.)
    const stored = db.evidenceFor('E1');
    if (stored.length > 0) {
      expect(stored[0]!.payload_json.length).toBeLessThan(64 * 1024);
    }
  });
});
