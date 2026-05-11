import { describe, expect, it } from 'vitest';
import { PRICING, estimateUsd, isStale } from './pricing.js';

describe('pricing constants', () => {
  it('has parseable valid_until for every model', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      const d = new Date(p.valid_until);
      expect(d.toString()).not.toBe('Invalid Date');
      // Soft warning if past, but don't fail CI (per PLAN F-20).
      if (d < new Date()) {
        console.warn(`pricing for ${model} is past valid_until=${p.valid_until}`);
      }
    }
  });
});

describe('estimateUsd', () => {
  it('returns null for unknown model', () => {
    expect(estimateUsd('not-a-model', 1000)).toBeNull();
  });

  it('returns a positive cost for known model', () => {
    const cost = estimateUsd('claude-opus-4-7', 10_000);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1); // sanity: 10KB diff is cheap
  });

  it('scales with input size', () => {
    const small = estimateUsd('claude-opus-4-7', 1_000)!;
    const big = estimateUsd('claude-opus-4-7', 100_000)!;
    expect(big).toBeGreaterThan(small);
  });
});

describe('isStale', () => {
  it('not stale on the valid_until date itself', () => {
    const now = new Date('2026-08-01T00:00:00Z');
    expect(isStale('claude-opus-4-7', now)).toBe(false);
  });

  it('stale 31 days after valid_until', () => {
    const now = new Date('2026-09-01T00:00:01Z'); // ~31 days past 2026-08-01
    expect(isStale('claude-opus-4-7', now)).toBe(true);
  });

  it('unknown model is treated as stale', () => {
    expect(isStale('not-a-model')).toBe(true);
  });
});
