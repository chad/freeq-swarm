import { describe, expect, it } from 'vitest';
import { buildUnifiedDiff, fetchPinnedDiff } from './diff.js';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeFakeGh(scriptBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-diff-'));
  const path = join(dir, 'gh');
  writeFileSync(path, `#!/usr/bin/env bash\n${scriptBody}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('buildUnifiedDiff', () => {
  it('emits standard headers per file', () => {
    const out = buildUnifiedDiff([
      {
        filename: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n line\n+new',
      },
    ]);
    expect(out).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(out).toContain('--- a/src/a.ts');
    expect(out).toContain('+++ b/src/a.ts');
    expect(out).toContain('@@ -1,1 +1,2 @@');
  });

  it('uses previous_filename for renames', () => {
    const out = buildUnifiedDiff([
      {
        filename: 'src/b.ts',
        status: 'renamed',
        previous_filename: 'src/a.ts',
        patch: '@@ -1 +1 @@\n-x\n+y',
      },
    ]);
    expect(out).toContain('diff --git a/src/a.ts b/src/b.ts');
    expect(out).toContain('--- a/src/a.ts');
    expect(out).toContain('+++ b/src/b.ts');
  });
});

// fetchPinnedDiff dispatches between three gh subcalls based on argv. We use
// a fake gh that switches on argv to return canned JSON.
const TINY_PR = `#!/usr/bin/env bash
url="$2"
case "$url" in
  repos/foo/bar/pulls/1)
    cat <<EOF
{"head":{"sha":"abc1234"},"base":{"sha":"f00f"}}
EOF
    ;;
  repos/foo/bar/commits/abc1234)
    cat <<EOF
{"sha":"abc1234"}
EOF
    ;;
  repos/foo/bar/compare/f00f...abc1234)
    cat <<'EOF'
{"files":[{"filename":"a.ts","status":"modified","additions":1,"deletions":1,"patch":"@@ -1 +1 @@\\n-old\\n+new"}]}
EOF
    ;;
  *)
    echo "unknown: $url" >&2
    exit 1
    ;;
esac
`;

describe('fetchPinnedDiff', () => {
  it('returns reconstructed diff on happy path', async () => {
    const fake = makeFakeGh(TINY_PR);
    const r = await fetchPinnedDiff({
      repo: 'foo/bar',
      pr: 1,
      expectedHeadSha: 'abc1234',
      opts: { ghBin: fake },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toBe(1);
      expect(r.totalAdditions).toBe(1);
      expect(r.diff).toContain('diff --git a/a.ts b/a.ts');
    }
  });

  it('refuses head_sha mismatch (force-push)', async () => {
    const fake = makeFakeGh(TINY_PR);
    const r = await fetchPinnedDiff({
      repo: 'foo/bar',
      pr: 1,
      expectedHeadSha: 'WRONGSHA',
      opts: { ghBin: fake },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('head_sha_lost');
  });

  it('treats commit-not-found as head_sha_lost', async () => {
    const fake = makeFakeGh(`
url="$2"
case "$url" in
  repos/foo/bar/pulls/1)
    cat <<EOF
{"head":{"sha":"abc1234"},"base":{"sha":"f00f"}}
EOF
    ;;
  repos/foo/bar/commits/abc1234)
    echo "HTTP 404 Not Found" >&2; exit 1
    ;;
esac
`);
    const r = await fetchPinnedDiff({
      repo: 'foo/bar',
      pr: 1,
      expectedHeadSha: 'abc1234',
      opts: { ghBin: fake },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('head_sha_lost');
  });

  it('refuses diff_too_large at 300-file cap', async () => {
    // Build a fake gh that returns 300 files.
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'modified',
      patch: '@@ -1 +1 @@\n-x\n+y',
    }));
    const compareJson = JSON.stringify({ files });
    const fake = makeFakeGh(`
url="$2"
case "$url" in
  repos/foo/bar/pulls/1)
    cat <<EOF
{"head":{"sha":"abc1234"},"base":{"sha":"f00f"}}
EOF
    ;;
  repos/foo/bar/commits/abc1234)
    echo '{"sha":"abc1234"}'
    ;;
  repos/foo/bar/compare/*)
    cat <<'EOF'
${compareJson}
EOF
    ;;
esac
`);
    const r = await fetchPinnedDiff({
      repo: 'foo/bar',
      pr: 1,
      expectedHeadSha: 'abc1234',
      opts: { ghBin: fake },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('diff_too_large');
  });

  it('refuses diff_too_large when a non-removed file has null patch (binary)', async () => {
    const fake = makeFakeGh(`
url="$2"
case "$url" in
  repos/foo/bar/pulls/1)
    echo '{"head":{"sha":"abc1234"},"base":{"sha":"f00f"}}'
    ;;
  repos/foo/bar/commits/abc1234)
    echo '{"sha":"abc1234"}'
    ;;
  repos/foo/bar/compare/*)
    echo '{"files":[{"filename":"img.png","status":"modified","patch":null}]}'
    ;;
esac
`);
    const r = await fetchPinnedDiff({
      repo: 'foo/bar',
      pr: 1,
      expectedHeadSha: 'abc1234',
      opts: { ghBin: fake },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('diff_too_large');
  });

  it('allows null patch when file was removed (deletion is meaningful)', async () => {
    const fake = makeFakeGh(`
url="$2"
case "$url" in
  repos/foo/bar/pulls/1)
    echo '{"head":{"sha":"abc1234"},"base":{"sha":"f00f"}}'
    ;;
  repos/foo/bar/commits/abc1234)
    echo '{"sha":"abc1234"}'
    ;;
  repos/foo/bar/compare/*)
    echo '{"files":[{"filename":"old.txt","status":"removed","patch":null}]}'
    ;;
esac
`);
    const r = await fetchPinnedDiff({
      repo: 'foo/bar',
      pr: 1,
      expectedHeadSha: 'abc1234',
      opts: { ghBin: fake },
    });
    expect(r.ok).toBe(true);
  });

  it('maps auth_error from PR fetch', async () => {
    const fake = makeFakeGh('echo "not logged into" >&2; exit 1');
    const r = await fetchPinnedDiff({
      repo: 'foo/bar',
      pr: 1,
      expectedHeadSha: 'abc1234',
      opts: { ghBin: fake },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('auth_error');
  });
});
