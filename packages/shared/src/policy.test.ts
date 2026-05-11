import { describe, expect, it } from 'vitest';
import { matchesAnyRepoPattern, matchesRepoPattern } from './policy.js';

describe('matchesRepoPattern', () => {
  it('matches exact repos', () => {
    expect(matchesRepoPattern('github.com/foo/bar', 'github.com/foo/bar')).toBe(true);
    expect(matchesRepoPattern('github.com/foo/bar', 'github.com/foo/baz')).toBe(false);
  });

  it('matches owner-glob', () => {
    expect(matchesRepoPattern('github.com/freeq-org/foo', 'github.com/freeq-org/*')).toBe(true);
    expect(matchesRepoPattern('github.com/other/foo', 'github.com/freeq-org/*')).toBe(false);
  });

  it('global * matches anything', () => {
    expect(matchesRepoPattern('anything', '*')).toBe(true);
  });

  it('no patterns rejects everything', () => {
    expect(matchesAnyRepoPattern('github.com/foo/bar', [])).toBe(false);
  });

  it('any-of patterns', () => {
    const patterns = ['github.com/freeq-org/*', 'github.com/chad-blueyard/*'];
    expect(matchesAnyRepoPattern('github.com/freeq-org/sdk', patterns)).toBe(true);
    expect(matchesAnyRepoPattern('github.com/chad-blueyard/cc', patterns)).toBe(true);
    expect(matchesAnyRepoPattern('github.com/random/repo', patterns)).toBe(false);
  });
});
