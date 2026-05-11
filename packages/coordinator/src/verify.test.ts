import { describe, expect, it } from 'vitest';
import { computeConsensus } from './verify.js';

describe('computeConsensus', () => {
  it('strict majority wins with score = bucket/total', () => {
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'approve', severity: 'none' },
      { worker_did: 'b', verdict: 'approve', severity: 'none' },
      { worker_did: 'c', verdict: 'request_changes', severity: 'medium' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict).toBe('approve');
      expect(r.agreement_score).toBeCloseTo(2 / 3);
      expect(r.dissenterDids).toEqual(['c']);
    }
  });

  it('unanimous returns agreement_score=1.0', () => {
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'approve_with_comments', severity: 'low' },
      { worker_did: 'b', verdict: 'approve_with_comments', severity: 'low' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agreement_score).toBe(1);
      expect(r.dissenterDids).toEqual([]);
    }
  });

  it('consensus_severity = max in picked bucket', () => {
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'request_changes', severity: 'medium' },
      { worker_did: 'b', verdict: 'request_changes', severity: 'high' },
      { worker_did: 'c', verdict: 'approve', severity: 'none' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict).toBe('request_changes');
      expect(r.severity).toBe('high');
    }
  });

  it('tie on severity tiebreak: higher max severity wins', () => {
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'approve', severity: 'none' },
      { worker_did: 'b', verdict: 'request_changes', severity: 'critical' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toBe('request_changes');
  });

  it('tie on severity AND severity equal: verdict order tiebreak (caution wins)', () => {
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'approve_with_comments', severity: 'low' },
      { worker_did: 'b', verdict: 'reject', severity: 'low' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toBe('reject');
  });

  it('agreement_score < 0.5 → irreconcilable', () => {
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'approve', severity: 'none' },
      { worker_did: 'b', verdict: 'request_changes', severity: 'high' },
      { worker_did: 'c', verdict: 'reject', severity: 'critical' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('consensus_irreconcilable');
      expect(r.detail).toMatch(/approve=1.*request_changes=1.*reject=1/);
    }
  });

  it('handles empty input', () => {
    const r = computeConsensus([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/no reviews/);
  });

  it('handles single review (trivial unanimity)', () => {
    const r = computeConsensus([{ worker_did: 'a', verdict: 'approve', severity: 'none' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict).toBe('approve');
      expect(r.agreement_score).toBe(1);
    }
  });

  it('all-approve unanimity does not trip irreconcilable for 4 workers', () => {
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'approve', severity: 'none' },
      { worker_did: 'b', verdict: 'approve', severity: 'none' },
      { worker_did: 'c', verdict: 'approve', severity: 'none' },
      { worker_did: 'd', verdict: 'approve', severity: 'none' },
    ]);
    expect(r.ok).toBe(true);
  });

  it('two-way 1-1 tie picks more cautious verdict', () => {
    // Same severity, different verdicts, same count.
    const r = computeConsensus([
      { worker_did: 'a', verdict: 'approve', severity: 'low' },
      { worker_did: 'b', verdict: 'request_changes', severity: 'low' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toBe('request_changes');
  });
});
