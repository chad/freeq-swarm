import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDidCache, parseInboundCoordinationEvent, parseTags } from '@freeq-swarm/shared';
import { CoordinatorDb } from './db.js';
import { handleInboundPrivmsg } from './dispatcher.js';

function makeFakeGh(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const path = join(dir, 'gh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const SUCCESS_GH = makeFakeGh(
  `cat <<'EOF'\n{"headRefOid":"abc1234","baseRefOid":"f00f","url":"https://github.com/foo/bar/pull/42"}\nEOF`,
);

const NOT_FOUND_GH = makeFakeGh('echo "HTTP 404 Not Found" >&2; exit 1');

const AUTH_ERR_GH = makeFakeGh('echo "not logged into any GitHub hosts" >&2; exit 1');

function makeDeps() {
  const sentLines: string[] = [];
  const fakeClient: any = {
    raw: (line: string) => sentLines.push(line),
  };
  const config = {
    swarm: {
      channel: '#swarm',
      founder_did: 'did:plc:founder',
      coordinator_nick: 'swarm',
      freeq_server: 'irc.freeq.at:6697',
    },
    operator_allowlist: ['did:plc:alice', 'did:plc:bob'],
    task_types: {
      pr_review: {
        reviewers_needed: 2,
        claim_window_ms: 30000,
        execution_timeout_ms: 300000,
        max_usd_per_reviewer: 1.5,
        allowed_repo_patterns: ['github.com/foo/*', 'github.com/freeq-org/*'],
        max_retries_on_timeout: 1,
      },
    },
    budget: { daily_usd_per_agent: 5 },
    summary: { default_tz: 'UTC', default_time: '09:00', per_requester_tz: {} },
  } as const;
  const db = new CoordinatorDb(':memory:');
  const didCache = createDidCache({
    whois: () => {},
    onMemberDid: () => () => {},
    defaultTimeoutMs: 50,
  });
  return { sentLines, fakeClient, config, db, didCache };
}

describe('handleInboundPrivmsg', () => {
  it('ignores messages not addressed to coordinator', async () => {
    const t = makeDeps();
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'alice', text: 'hello world' },
    );
    expect(t.sentLines).toHaveLength(0);
  });

  it('ignores DMs (Phase 2 only handles channel msgs)', async () => {
    const t = makeDeps();
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: 'swarm', from: 'alice', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    expect(t.sentLines).toHaveLength(0);
  });

  it('NOTICEs the requester on parse error', async () => {
    const t = makeDeps();
    t.didCache.set('alice', 'did:plc:alice');
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm summarize https://x' },
    );
    expect(t.sentLines.some((l) => l.startsWith('NOTICE alice'))).toBe(true);
  });

  it('refuses when requester DID cannot be resolved', async () => {
    const t = makeDeps();
    // No did set for "alice"; cache will WHOIS-then-timeout.
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    expect(t.sentLines.some((l) => /could not resolve/.test(l))).toBe(true);
  });

  it('refuses when requester DID is not in operator_allowlist', async () => {
    const t = makeDeps();
    t.didCache.set('mallory', 'did:plc:mallory'); // not in allowlist
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'mallory', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    expect(t.sentLines.some((l) => /not in the operator allowlist/.test(l))).toBe(true);
  });

  it('refuses when repo does not match allowed_repo_patterns', async () => {
    const t = makeDeps();
    t.didCache.set('alice', 'did:plc:alice');
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/random-owner/repo/pull/1' },
    );
    expect(t.sentLines.some((l) => /does not match any allowed pattern/.test(l))).toBe(true);
  });

  it('emits task_request TAGMSG + PRIVMSG on happy path', async () => {
    const t = makeDeps();
    t.didCache.set('alice', 'did:plc:alice');
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    // Expect a TAGMSG and a PRIVMSG with task_request event.
    const evtLines = t.sentLines.filter((l) => /\+freeq\.at\/event=task_request/.test(l));
    expect(evtLines.length).toBe(2);
    const tagmsg = evtLines.find((l) => / TAGMSG /.test(l));
    expect(tagmsg).toBeDefined();
    const parsed = parseInboundCoordinationEvent(tagmsg!);
    expect(parsed!.eventType).toBe('task_request');
    expect((parsed!.payload as any).target.head_sha).toBe('abc1234');
    expect((parsed!.payload as any).target.repo).toBe('github.com/foo/bar');
    expect((parsed!.payload as any).requester_did).toBe('did:plc:alice');
    // SQLite has the task row.
    const tid = parsed!.eventId;
    expect(t.db.getTask(tid)).not.toBeNull();
  });

  it('emits task_failed on gh ingestion error', async () => {
    const t = makeDeps();
    t.didCache.set('alice', 'did:plc:alice');
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: NOT_FOUND_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    const evtLines = t.sentLines.filter((l) => /\+freeq\.at\/event=task_failed/.test(l));
    expect(evtLines.length).toBe(2);
    const tagmsg = evtLines.find((l) => / TAGMSG /.test(l))!;
    const parsed = parseInboundCoordinationEvent(tagmsg)!;
    expect((parsed.payload as any).reason).toBe('ingestion_error');
    expect((parsed.payload as any).detail).toMatch(/repo_not_found_or_private/);
  });

  it('distinguishes auth_error from not_found in failure detail', async () => {
    const t = makeDeps();
    t.didCache.set('alice', 'did:plc:alice');
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: AUTH_ERR_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    const tagmsg = t.sentLines.find((l) => /event=task_failed/.test(l) && / TAGMSG /.test(l))!;
    const parsed = parseInboundCoordinationEvent(tagmsg)!;
    expect((parsed.payload as any).detail).toMatch(/auth_error/);
  });

  it('honors reviewers= flag override on task_request payload', async () => {
    const t = makeDeps();
    t.didCache.set('alice', 'did:plc:alice');
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'alice', text: '@swarm review https://github.com/foo/bar/pull/42 reviewers=3' },
    );
    const tagmsg = t.sentLines.find((l) => /event=task_request/.test(l) && / TAGMSG /.test(l))!;
    const parsed = parseInboundCoordinationEvent(tagmsg)!;
    expect((parsed.payload as any).policy.reviewers_needed).toBe(3);
  });

  it('ignores echo from coordinator nick (echo-message cap)', async () => {
    const t = makeDeps();
    await handleInboundPrivmsg(
      { client: t.fakeClient, db: t.db, config: t.config as any, didCache: t.didCache, ghOpts: { ghBin: SUCCESS_GH } },
      { target: '#swarm', from: 'swarm', text: '@swarm review https://github.com/foo/bar/pull/42' },
    );
    expect(t.sentLines).toHaveLength(0);
  });
});
