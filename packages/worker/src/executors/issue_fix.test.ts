import { describe, expect, it } from 'vitest';
import { buildUserPrompt, parseDiffStat } from './issue_fix.js';

describe('parseDiffStat', () => {
  it('extracts files / additions / deletions from a typical git diff --stat tail', () => {
    const out = parseDiffStat(
      ' src/a.ts | 2 +-\n src/b.ts | 5 +++--\n 2 files changed, 4 insertions(+), 3 deletions(-)\n',
    );
    expect(out).toEqual({ files: 2, additions: 4, deletions: 3 });
  });

  it('handles single-file diff (no plural)', () => {
    const out = parseDiffStat(' src/a.ts | 1 +\n 1 file changed, 1 insertion(+)\n');
    expect(out).toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it('returns zeros for empty stat', () => {
    expect(parseDiffStat('')).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe('buildUserPrompt', () => {
  it('includes repo, issue, title, body in a consistent layout', () => {
    const out = buildUserPrompt({
      repo: 'foo/bar',
      issue: 42,
      title: 'add /healthz',
      body: 'We need a health endpoint.',
    });
    expect(out).toContain('Issue: foo/bar #42');
    expect(out).toContain('Title: add /healthz');
    expect(out).toContain('We need a health endpoint.');
  });
});
