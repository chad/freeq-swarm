import { describe, expect, it } from 'vitest';
import { mapGhFailure, fetchPrHeadInfo } from './gh.js';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('mapGhFailure', () => {
  it('detects auth errors', () => {
    expect(mapGhFailure('not logged into any GitHub hosts').kind).toBe('auth_error');
    expect(mapGhFailure('http 401: Bad credentials').kind).toBe('auth_error');
  });
  it('detects not-found / private repo', () => {
    expect(mapGhFailure('Could not resolve to a Repository with the name "x"').kind).toBe(
      'repo_not_found_or_private',
    );
    expect(mapGhFailure('HTTP 404 Not Found').kind).toBe('repo_not_found_or_private');
  });
  it('falls back to network error', () => {
    expect(mapGhFailure('connection reset by peer').kind).toBe('network_error');
    expect(mapGhFailure('').kind).toBe('network_error');
  });
});

// Use a fake `gh` shell script so we can test fetchPrHeadInfo without a real
// GitHub auth or network round-trip.
function makeFakeGh(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const path = join(dir, 'gh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('fetchPrHeadInfo', () => {
  it('parses headRefOid + baseRefOid', async () => {
    const fake = makeFakeGh(
      `cat <<'EOF'\n{"headRefOid":"deadbeef","baseRefOid":"f00f","url":"https://github.com/foo/bar/pull/1"}\nEOF`,
    );
    const r = await fetchPrHeadInfo('foo/bar', 1, { ghBin: fake });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.head_sha).toBe('deadbeef');
      expect(r.info.base_sha).toBe('f00f');
      expect(r.info.diff_url).toBe('https://github.com/foo/bar/pull/1.diff');
    }
  });

  it('maps auth-error stderr correctly', async () => {
    const fake = makeFakeGh('echo "not logged into any GitHub hosts" >&2; exit 1');
    const r = await fetchPrHeadInfo('foo/bar', 1, { ghBin: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('auth_error');
  });

  it('maps 404-style stderr to repo_not_found_or_private', async () => {
    const fake = makeFakeGh('echo "HTTP 404 Not Found" >&2; exit 1');
    const r = await fetchPrHeadInfo('foo/bar', 1, { ghBin: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('repo_not_found_or_private');
  });

  it('rejects malformed JSON', async () => {
    const fake = makeFakeGh('echo "not json"; exit 0');
    const r = await fetchPrHeadInfo('foo/bar', 1, { ghBin: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('network_error');
  });

  it('rejects JSON missing oids', async () => {
    const fake = makeFakeGh(`cat <<'EOF'\n{"unrelated":1}\nEOF`);
    const r = await fetchPrHeadInfo('foo/bar', 1, { ghBin: fake });
    expect(r.ok).toBe(false);
  });

  it('handles missing gh binary', async () => {
    const r = await fetchPrHeadInfo('foo/bar', 1, { ghBin: '/no/such/binary' });
    expect(r.ok).toBe(false);
  });

  it('respects timeout (kills slow gh)', async () => {
    const fake = makeFakeGh('sleep 5');
    const r = await fetchPrHeadInfo('foo/bar', 1, { ghBin: fake, timeoutMs: 100 }).catch(
      (e) => ({ ok: false as const, failure: { kind: 'network_error' as const, message: String(e) } }),
    );
    expect(r.ok).toBe(false);
  });
});
