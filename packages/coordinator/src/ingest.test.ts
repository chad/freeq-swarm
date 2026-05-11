import { describe, expect, it } from 'vitest';
import { parseTaskCommand, stripAddressing } from './ingest.js';

describe('stripAddressing', () => {
  it('strips @swarm prefix', () => {
    expect(stripAddressing('@swarm review https://x', 'swarm')).toBe('review https://x');
  });
  it('strips swarm: prefix', () => {
    expect(stripAddressing('swarm: review https://x', 'swarm')).toBe('review https://x');
  });
  it('strips swarm, prefix', () => {
    expect(stripAddressing('swarm, review https://x', 'swarm')).toBe('review https://x');
  });
  it('returns null for non-matching nick', () => {
    expect(stripAddressing('@otherbot review https://x', 'swarm')).toBeNull();
  });
  it('case-insensitive nick match', () => {
    expect(stripAddressing('@SWARM review x', 'swarm')).toBe('review x');
    expect(stripAddressing('@swarm review x', 'SWARM')).toBe('review x');
  });
  it('returns null for messages without addressing', () => {
    expect(stripAddressing('hello world', 'swarm')).toBeNull();
  });
});

describe('parseTaskCommand', () => {
  it('parses a basic review command', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/42');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.repo).toBe('github.com/foo/bar');
      expect(r.spec.pr).toBe(42);
      expect(r.spec.url).toBe('https://github.com/foo/bar/pull/42');
    }
  });

  it('parses reviewers + priority flags', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/1 reviewers=3 priority=high');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.flags.reviewers).toBe(3);
      expect(r.spec.flags.priority).toBe('high');
    }
  });

  it('rejects unknown task type', () => {
    const r = parseTaskCommand('summarize https://github.com/foo/bar/pull/42');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_task_type');
  });

  it('rejects missing url', () => {
    const r = parseTaskCommand('review');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_url');
  });

  it('rejects malformed url', () => {
    const r = parseTaskCommand('review http://example.com/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_url');
  });

  it('rejects unknown flag', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/1 cuteness=high');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_flag');
  });

  it('rejects bad reviewers value', () => {
    expect(parseTaskCommand('review https://github.com/foo/bar/pull/1 reviewers=0').ok).toBe(false);
    expect(parseTaskCommand('review https://github.com/foo/bar/pull/1 reviewers=99').ok).toBe(false);
    expect(parseTaskCommand('review https://github.com/foo/bar/pull/1 reviewers=abc').ok).toBe(false);
  });

  it('rejects bad priority value', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/1 priority=urgent');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_flag_value');
  });

  it('accepts http, https, with trailing slash', () => {
    expect(parseTaskCommand('review https://github.com/foo/bar/pull/42/').ok).toBe(true);
  });

  it('rejects URL with embedded shell metachars in flag value', () => {
    const r = parseTaskCommand('review https://github.com/foo/bar/pull/1 model=foo;rm');
    expect(r.ok).toBe(false);
  });

  it('accepts owner+repo names with dashes and dots', () => {
    const r = parseTaskCommand('review https://github.com/some-org/my.repo/pull/7');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.repo).toBe('github.com/some-org/my.repo');
  });
});
